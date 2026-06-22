# Meena Scheduling

This project now includes an optional **WhatsApp Web bridge** for low-volume notifications.

## WhatsApp notifications (free / unofficial)

For low-volume alerts (like 2–3 per month), you can use WhatsApp Web instead of the paid official API.

### What was added

- `whatsapp-bridge/` — Node.js service using `whatsapp-web.js`
- Optional integration in the FastAPI app via environment variables

### Bridge setup

```bash
cd whatsapp-bridge
npm install
BRIDGE_API_TOKEN=change-me node server.js
```

On first run, a QR code will appear in the terminal. Scan it with the WhatsApp account you want to send from.

### Bridge endpoints

- `GET /health`
- `GET /session` — shows readiness + QR (protected if token is set)
- `POST /send` — send a WhatsApp message

Example:

```bash
curl -X POST http://localhost:3003/send \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer change-me' \
  -d '{"to":"0556449881","message":"Hello from Meena"}'
```

### FastAPI integration

Set these environment variables on the main Meena app:

```env
WHATSAPP_NOTIFY_URL=http://localhost:3003/send
WHATSAPP_NOTIFY_TOKEN=change-me
WHATSAPP_ONLY_TYPES=leave,approved,review,reminder,swap,info
```

When configured, in-app notifications will still be created as usual, and the server will also try to send WhatsApp to the linked staff phone number when available.

### Notes

- This is **not an official WhatsApp API**
- It can disconnect and may require rescanning QR sometimes
- Best for low-volume personal/internal alerts
- Better on a VPS or always-on machine than a fully ephemeral deployment
