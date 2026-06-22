const express = require('express');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = Number(process.env.PORT || 3003);
const API_TOKEN = process.env.BRIDGE_API_TOKEN || '';
const SESSION_NAME = process.env.WHATSAPP_SESSION_NAME || 'meena-whatsapp';
// Defaults to all interfaces to preserve the current direct-IP setup. For the
// hardened setup, set BRIDGE_HOST=127.0.0.1 and front it with nginx + TLS
// (see OPERATIONS.md) so the raw port isn't exposed to the internet.
const HOST = process.env.BRIDGE_HOST || '0.0.0.0';

if (!API_TOKEN) {
  console.warn('⚠  BRIDGE_API_TOKEN is NOT set — /send and /session are UNAUTHENTICATED. ' +
               'Set BRIDGE_API_TOKEN (matching WHATSAPP_NOTIFY_TOKEN on the app) before exposing this service.');
}

const app = express();
app.use(express.json({ limit: '1mb' }));

let client = null;
let latestQr = null;
let isReady = false;
let lastState = 'starting';
let reconnectTimer = null;

function buildClient() {
  const c = new Client({
    authStrategy: new LocalAuth({ clientId: SESSION_NAME }),
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
  c.on('ready', () => { latestQr = null; isReady = true; lastState = 'ready'; console.log('WhatsApp client is ready'); });
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
// what caused the "Attempted to use detached Frame" errors. A fresh Client avoids it.
function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  console.warn(`Scheduling WhatsApp reconnect in 5s (${reason})…`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try { if (client) await client.destroy(); } catch (e) { console.warn('destroy failed:', e.message); }
    client = buildClient();
    lastState = 'reconnecting';
    client.initialize().catch((e) => {
      console.error('re-init failed:', e.message);
      scheduleReconnect('reinit-failed');
    });
  }, 5000);
}

function requireAuth(req, res, next) {
  if (!API_TOKEN) return next();
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${API_TOKEN}`) return next();
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

app.post('/send', requireAuth, async (req, res) => {
  try {
    if (!isReady || !client) {
      return res.status(503).json({ ok: false, error: 'WhatsApp client is not ready yet' });
    }
    const digits = normalizeDigits(req.body && req.body.to);
    const message = String((req.body && req.body.message) || '').trim();
    if (!message) return res.status(400).json({ ok: false, error: 'Message is required' });

    // Resolve the real WhatsApp chat id; gives a clear error for non-WhatsApp numbers.
    let chatId;
    try {
      const numberId = await client.getNumberId(digits);
      if (!numberId) return res.status(422).json({ ok: false, error: 'Recipient is not on WhatsApp' });
      chatId = numberId._serialized;
    } catch (_e) {
      chatId = `${digits}@c.us`;   // fall back if the lookup itself fails
    }

    const result = await client.sendMessage(chatId, message);
    return res.json({ ok: true, id: (result.id && result.id._serialized) || null, to: chatId });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || 'Send failed' });
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
});

client = buildClient();
client.initialize();
