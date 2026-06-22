const express = require('express');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = Number(process.env.PORT || 3003);
const API_TOKEN = process.env.BRIDGE_API_TOKEN || '';
const SESSION_NAME = process.env.WHATSAPP_SESSION_NAME || 'meena-whatsapp';

const app = express();
app.use(express.json({ limit: '1mb' }));

let latestQr = null;
let isReady = false;
let lastState = 'starting';

const client = new Client({
  authStrategy: new LocalAuth({ clientId: SESSION_NAME }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  }
});

client.on('qr', (qr) => {
  latestQr = qr;
  isReady = false;
  lastState = 'qr';
  console.log('\n=== WhatsApp QR ===');
  qrcode.generate(qr, { small: true });
  console.log('===================\n');
});

client.on('ready', () => {
  latestQr = null;
  isReady = true;
  lastState = 'ready';
  console.log('WhatsApp client is ready');
});

client.on('authenticated', () => {
  lastState = 'authenticated';
  console.log('WhatsApp authenticated');
});

client.on('auth_failure', (msg) => {
  isReady = false;
  lastState = 'auth_failure';
  console.error('WhatsApp auth failure:', msg);
});

client.on('disconnected', (reason) => {
  isReady = false;
  lastState = `disconnected:${reason}`;
  console.warn('WhatsApp disconnected:', reason);
});

function requireAuth(req, res, next) {
  if (!API_TOKEN) return next();
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${API_TOKEN}`) return next();
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

function normalizeNumber(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Missing recipient number');
  let digits = raw.replace(/\D+/g, '');
  if (!digits) throw new Error('Invalid recipient number');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `966${digits.slice(1)}`;
  if (!/^\d{8,15}$/.test(digits)) throw new Error('Invalid recipient number length');
  return `${digits}@c.us`;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, ready: isReady, state: lastState, hasQr: !!latestQr });
});

app.get('/session', requireAuth, (_req, res) => {
  res.json({ ok: true, ready: isReady, state: lastState, qr: latestQr });
});

app.post('/send', requireAuth, async (req, res) => {
  try {
    if (!isReady) {
      return res.status(503).json({ ok: false, error: 'WhatsApp client is not ready yet' });
    }
    const to = normalizeNumber(req.body?.to);
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ ok: false, error: 'Message is required' });
    const result = await client.sendMessage(to, message);
    return res.json({ ok: true, id: result.id?._serialized || null, to });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || 'Send failed' });
  }
});

app.listen(PORT, () => {
  console.log(`WhatsApp bridge listening on :${PORT}`);
});

client.initialize();
