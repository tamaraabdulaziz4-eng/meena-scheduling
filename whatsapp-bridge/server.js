const express = require('express');
const qrcode = require('qrcode-terminal');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = Number(process.env.PORT || 3003);
const API_TOKEN = process.env.BRIDGE_API_TOKEN || '';
const SESSION_NAME = process.env.WHATSAPP_SESSION_NAME || 'meena-whatsapp';
// Session files live next to this file by default (NOT process.cwd()), so the
// linked session survives no matter which directory systemd launches us from.
// Override with WHATSAPP_DATA_PATH to point at a mounted/persistent volume.
const DATA_PATH = process.env.WHATSAPP_DATA_PATH || path.join(__dirname, '.wwebjs_auth');
// Defaults to all interfaces to preserve the current direct-IP setup. For the
// hardened setup, set BRIDGE_HOST=127.0.0.1 and front it with nginx + TLS
// (see OPERATIONS.md) so the raw port isn't exposed to the internet.
const HOST = process.env.BRIDGE_HOST || '0.0.0.0';
const PUBLIC_BIND = !['127.0.0.1', 'localhost', '::1'].includes(HOST);

// Hard safety: never run an UNAUTHENTICATED bridge on a public interface — that
// is an open relay to send WhatsApp from the linked (personal!) account. Either
// set a token, or bind to localhost (BRIDGE_HOST=127.0.0.1) behind nginx.
if (PUBLIC_BIND && !API_TOKEN) {
  console.error('✗ Refusing to start: bound to ' + HOST + ' with no BRIDGE_API_TOKEN. ' +
                'Set BRIDGE_API_TOKEN, or set BRIDGE_HOST=127.0.0.1 and use nginx. See OPERATIONS.md.');
  process.exit(1);
}
if (!API_TOKEN) {
  console.warn('⚠  BRIDGE_API_TOKEN is NOT set — /send and /session are UNAUTHENTICATED (localhost only).');
}

const app = express();
app.use(express.json({ limit: '1mb' }));

// Lightweight rate limit on /send so a leaked token can't be used to blast
// messages from the account. Tune with SEND_RATE_PER_MIN (default 30/min).
const SEND_RATE = Number(process.env.SEND_RATE_PER_MIN || 30);
let _sendWindow = { start: Date.now(), count: 0 };
function rateOk() {
  const now = Date.now();
  if (now - _sendWindow.start >= 60000) _sendWindow = { start: now, count: 0 };
  _sendWindow.count += 1;
  return _sendWindow.count <= SEND_RATE;
}

let client = null;
let latestQr = null;
let isReady = false;
let lastState = 'starting';
let reconnectTimer = null;
let reconnectAttempts = 0;     // drives exponential backoff; reset on 'ready'
let badChecks = 0;             // consecutive watchdog failures
let sendFails = 0;             // consecutive /send failures (stuck-session signal)

// WhatsApp's "LID" (hidden-number) rollout breaks older WhatsApp Web builds with
// "Lid is missing in chat table" on send. Pin a recent known-good build; bump it
// via WA_WEB_VERSION when it ages out (list: github.com/wppconnect-team/wa-version).
const WA_WEB_VERSION = process.env.WA_WEB_VERSION || '2.3000.1042229403-alpha';

function buildClient() {
  const c = new Client({
    authStrategy: new LocalAuth({ clientId: SESSION_NAME, dataPath: DATA_PATH }),
    webVersionCache: {
      type: 'remote',
      remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${WA_WEB_VERSION}.html`,
    },
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
  });

  c.on('qr', (qr) => {
    latestQr = qr; isReady = false; lastState = 'qr';
    console.log('\n=== WhatsApp QR ===');
    qrcode.generate(qr, { small: true });
    console.log('===================\n');
  });
  c.on('ready', () => {
    latestQr = null; isReady = true; lastState = 'ready';
    reconnectAttempts = 0; badChecks = 0; sendFails = 0;
    console.log('WhatsApp client is ready');
  });
  c.on('authenticated', () => { lastState = 'authenticated'; console.log('WhatsApp authenticated'); });
  c.on('auth_failure', (msg) => { isReady = false; lastState = 'auth_failure'; console.error('WhatsApp auth failure:', msg); });
  c.on('disconnected', (reason) => {
    isReady = false; lastState = `disconnected:${reason}`;
    console.warn('WhatsApp disconnected:', reason);
    scheduleReconnect(`disconnected:${reason}`);
  });
  return c;
}

// Rebuild the client from scratch on disconnect — reusing a destroyed context is
// what caused the "Attempted to use detached Frame" errors. A fresh Client avoids
// it. The LocalAuth session on disk persists, so this reconnects WITHOUT a new QR
// unless WhatsApp actually logged the device out. Backs off 5s→10s→20s→…→max 60s.
function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  isReady = false;
  const delay = Math.min(5000 * Math.pow(2, reconnectAttempts), 60000);
  reconnectAttempts += 1;
  console.warn(`Scheduling WhatsApp reconnect in ${delay}ms (attempt ${reconnectAttempts}, ${reason})…`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    lastState = 'reconnecting';
    try { if (client) await client.destroy(); } catch (e) { console.warn('destroy failed:', e.message); }
    client = buildClient();
    client.initialize().catch((e) => {
      console.error('re-init failed:', e.message);
      scheduleReconnect('reinit-failed');
    });
  }, delay);
}

// ── Health watchdog ─────────────────────────────────────────────────────────
// whatsapp-web.js' worst failure is SILENT: the page detaches or the session
// goes stale, /send hangs and times out, but no 'disconnected' event ever fires —
// so the bridge sits "ready" but broken until a human restarts it. We actively
// poll getState(); after a few consecutive bad reads we force a rebuild, which
// self-heals the stuck state without a manual QR re-scan.
const HEALTH_CHECK_MS = Number(process.env.HEALTH_CHECK_MS || 60000);
const MAX_BAD_CHECKS = Number(process.env.MAX_BAD_CHECKS || 3);
const STATE_TIMEOUT_MS = Number(process.env.STATE_TIMEOUT_MS || 10000);

async function checkHealth() {
  // Skip while we're already (re)connecting or waiting for a QR scan.
  if (reconnectTimer || !client || ['qr', 'reconnecting', 'starting'].includes(lastState)) return;
  let state = null;
  try {
    state = await withTimeout(client.getState(), STATE_TIMEOUT_MS, 'getState');
  } catch (e) {
    state = null;  // a throw/timeout here means the page is detached → unhealthy
  }
  if (state === 'CONNECTED') {
    badChecks = 0;
    if (!isReady) { isReady = true; lastState = 'ready'; }  // recovered on its own
    return;
  }
  badChecks += 1;
  console.warn(`Health check ${badChecks}/${MAX_BAD_CHECKS}: state=${state || 'unreachable'}`);
  if (badChecks >= MAX_BAD_CHECKS) {
    badChecks = 0;
    isReady = false;
    scheduleReconnect(`watchdog: stuck (state=${state || 'unreachable'})`);
  }
}
setInterval(() => { checkHealth().catch(() => {}); }, HEALTH_CHECK_MS).unref();

const crypto = require('crypto');
function requireAuth(req, res, next) {
  if (!API_TOKEN) return next();
  const auth = req.headers.authorization || '';
  const expected = `Bearer ${API_TOKEN}`;
  // Constant-time compare to avoid leaking the token via timing.
  const a = Buffer.from(auth), b = Buffer.from(expected);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

function normalizeDigits(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Missing recipient number');
  let digits = raw.replace(/\D+/g, '');
  if (!digits) throw new Error('Invalid recipient number');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `966${digits.slice(1)}`;
  if (!/^\d{8,15}$/.test(digits)) throw new Error('Invalid recipient number length');
  return digits;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, ready: isReady, state: lastState, hasQr: !!latestQr });
});

app.get('/session', requireAuth, (_req, res) => {
  res.json({ ok: true, ready: isReady, state: lastState, qr: latestQr });
});

// Browser-friendly QR page for (re)linking WhatsApp. Open in any browser and
// scan with the phone's WhatsApp → Linked devices → Link a device.
// Auth via ?token=<BRIDGE_API_TOKEN> (so it works from a plain browser URL).
app.get('/qr', async (req, res) => {
  if (API_TOKEN) {
    const t = String(req.query.token || '');
    const a = Buffer.from(t), b = Buffer.from(API_TOKEN);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).send('Unauthorized — add ?token=YOUR_BRIDGE_API_TOKEN');
    }
  }
  const wrap = (inner) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="refresh" content="15"><body style="font-family:system-ui,sans-serif;text-align:center;padding:28px;background:#f4f1fb">
    ${inner}<p style="color:#9a95ba;font-size:12px;margin-top:18px">state: ${lastState} · auto-refreshes every 15s</p></body>`;
  if (isReady) return res.send(wrap('<h2>✅ WhatsApp is already linked.</h2>'));
  if (!latestQr) return res.send(wrap('<h2>Starting…</h2><p>Waiting for a QR. Refresh in a moment.</p>'));
  try {
    const QRCode = require('qrcode');
    const dataUrl = await QRCode.toDataURL(latestQr, { width: 320, margin: 2 });
    res.send(wrap(`<h2>Link Meena WhatsApp</h2>
      <p>WhatsApp → <b>Linked devices</b> → <b>Link a device</b> → scan this:</p>
      <img src="${dataUrl}" style="width:320px;height:320px;border-radius:12px;background:#fff;padding:10px">`));
  } catch (e) {
    res.status(500).send('QR render error: ' + e.message + ' (run: npm install)');
  }
});

// Cap a hanging WhatsApp Web call so the request fails fast with a clear error
// instead of leaving the caller to time out with no information.
function withTimeout(promise, ms, label) {
  let t;
  const guard = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(t));
}
// Keep lookup + send UNDER the app's HTTP timeout (≈20s) so the bridge returns a
// clean JSON error within the window instead of the app reporting a blind "timed
// out". Worst case here is 6s + 12s = 18s < 20s. Tune via the env vars.
const LOOKUP_TIMEOUT_MS = Number(process.env.LOOKUP_TIMEOUT_MS || 6000);
const SEND_TIMEOUT_MS   = Number(process.env.SEND_TIMEOUT_MS   || 12000);

app.post('/send', requireAuth, async (req, res) => {
  try {
    if (!rateOk()) return res.status(429).json({ ok: false, error: 'Rate limit exceeded' });
    if (!isReady || !client) {
      return res.status(503).json({ ok: false, error: 'WhatsApp client is not ready yet' });
    }
    const digits = normalizeDigits(req.body && req.body.to);
    const message = String((req.body && req.body.message) || '').trim();
    if (!message) return res.status(400).json({ ok: false, error: 'Message is required' });

    // The contact lookup (getNumberId) can hang on some WhatsApp Web builds —
    // that's what makes /send time out. Cap it and fall back to the raw chat id,
    // which sendMessage resolves on its own.
    let chatId = `${digits}@c.us`;
    try {
      const numberId = await withTimeout(client.getNumberId(digits), LOOKUP_TIMEOUT_MS, 'getNumberId');
      if (numberId && numberId._serialized) chatId = numberId._serialized;
    } catch (e) {
      console.warn('getNumberId skipped:', e.message);
    }

    const result = await withTimeout(client.sendMessage(chatId, message), SEND_TIMEOUT_MS, 'sendMessage');
    sendFails = 0;  // a real send proves the session is alive
    return res.json({ ok: true, id: (result.id && result.id._serialized) || null, to: chatId });
  } catch (err) {
    const msg = err.message || 'Send failed';
    const timedOut = /timed out/i.test(msg);
    // A run of timed-out sends means the session is stuck even though no
    // 'disconnected' fired — kick a rebuild now instead of waiting for the watchdog.
    if (timedOut && ++sendFails >= 2) { sendFails = 0; scheduleReconnect('repeated send timeouts'); }
    const code = timedOut ? 504 : 400;
    return res.status(code).json({ ok: false, error: msg });
  }
});

// Don't let a stray rejection/exception take the whole bridge down.
process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err && err.message));

// Clean shutdown so systemd restarts get a fresh browser context.
async function shutdown(sig) {
  console.log(`Received ${sig}, shutting down…`);
  try { if (client) await client.destroy(); } catch (_e) {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

app.listen(PORT, HOST, () => {
  console.log(`WhatsApp bridge listening on ${HOST}:${PORT}`);
  console.log(`Session store: ${DATA_PATH} (clientId=${SESSION_NAME})`);
});

client = buildClient();
client.initialize();
