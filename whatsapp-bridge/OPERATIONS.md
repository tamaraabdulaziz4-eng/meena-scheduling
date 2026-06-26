# Meena WhatsApp Bridge — Operations

Unofficial WhatsApp Web bridge (`whatsapp-web.js`) that Meena's FastAPI app calls
to fan out notifications. Runs on a VPS as the `meena-whatsapp` systemd service.

## How it connects

```
Railway (Meena app)  --HTTP POST /send + Bearer token-->  VPS bridge :3003  -->  WhatsApp
```

The app sends `Authorization: Bearer $WHATSAPP_NOTIFY_TOKEN`.
The bridge checks `Authorization: Bearer $BRIDGE_API_TOKEN`.
**These two values MUST match.** If `BRIDGE_API_TOKEN` is empty the bridge accepts
**unauthenticated** requests — never expose it publicly without a token.

## Env vars

| Side | Var | Example |
|------|-----|---------|
| Railway app | `WHATSAPP_NOTIFY_URL` | `https://wa.example.com/send` (or `http://IP:3003/send`) |
| Railway app | `WHATSAPP_NOTIFY_TOKEN` | `meena_bridge_2025_wa_secret_991` |
| Railway app | `WHATSAPP_ONLY_TYPES` | `leave,approved,review,reminder,swap,info` |
| Railway app | `WHATSAPP_DEFAULT_COUNTRY` | `966` |
| VPS bridge | `BRIDGE_API_TOKEN` | `meena_bridge_2025_wa_secret_991` (same as above) |
| VPS bridge | `BRIDGE_HOST` | `127.0.0.1` (hardened) or `0.0.0.0` (direct IP) |
| VPS bridge | `PORT` | `3003` |
| VPS bridge | `WHATSAPP_DATA_PATH` | (optional) where the linked session is stored; defaults to `whatsapp-bridge/.wwebjs_auth` next to `server.js` |
| VPS bridge | `HEALTH_CHECK_MS` | (optional) watchdog interval, default `60000` |
| VPS bridge | `MAX_BAD_CHECKS` | (optional) bad reads before a forced rebuild, default `3` |

## Staying linked (no more repeated QR re-scans)

The bridge keeps itself healthy automatically:

- **Health watchdog** — every `HEALTH_CHECK_MS` it reads `getState()`. WhatsApp Web
  can go *silently* stuck (the page detaches, `/send` times out, but **no
  `disconnected` event fires**). After `MAX_BAD_CHECKS` bad reads the bridge
  rebuilds the client and reconnects from the **saved session — no QR needed**.
- **Send-timeout trip** — two `/send` timeouts in a row also force an immediate
  rebuild instead of waiting for the next watchdog tick.
- **Stable session path** — the linked session is stored next to `server.js`
  (`WHATSAPP_DATA_PATH`), so it survives restarts regardless of the working
  directory systemd launches from. **Do not delete `.wwebjs_auth/`** — that is the
  one thing that forces a fresh QR.

A QR re-scan is now only needed if WhatsApp itself logs the device out
(`/health` → `state:"qr"`). Re-link via `https://<bridge>/qr?token=<BRIDGE_API_TOKEN>`.

## Everyday commands

```bash
systemctl status meena-whatsapp --no-pager
systemctl restart meena-whatsapp
journalctl -u meena-whatsapp -f
curl -s http://127.0.0.1:3003/health | jq
```

Confirm the token is set on the service (should print a non-empty value):

```bash
systemctl show meena-whatsapp -p Environment | tr ' ' '\n' | grep BRIDGE_API_TOKEN
```

Test an authenticated send from the VPS itself:

```bash
curl -s -X POST http://127.0.0.1:3003/send \
  -H "Authorization: Bearer meena_bridge_2025_wa_secret_991" \
  -H "Content-Type: application/json" \
  -d '{"to":"05XXXXXXXX","message":"bridge test ✅"}' | jq
```

## Update the bridge code (on the VPS)

```bash
cd /path/to/meena-scheduling && git pull
cd whatsapp-bridge && npm install --omit=dev
systemctl restart meena-whatsapp
journalctl -u meena-whatsapp -n 30 --no-pager
```

## Hardening (recommended) — nginx + TLS, close the raw port

Goal: stop exposing `:3003` to the internet; serve it over HTTPS behind nginx and
only allow localhost to talk to the Node process.

1) Bind the bridge to localhost only:

```bash
systemctl edit meena-whatsapp
# add under [Service]:
#   Environment=BRIDGE_HOST=127.0.0.1
systemctl daemon-reload && systemctl restart meena-whatsapp
```

2) Firewall: allow SSH + HTTPS, drop the raw bridge port from the internet:

```bash
ufw allow 22/tcp
ufw allow 443/tcp
ufw deny 3003/tcp
ufw --force enable
ufw status verbose
```

3) nginx reverse proxy with a real cert (replace `wa.example.com`):

```bash
apt-get update && apt-get install -y nginx certbot python3-certbot-nginx
cat >/etc/nginx/sites-available/meena-wa <<'NGINX'
server {
    server_name wa.example.com;
    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_set_header Host $host;
        proxy_read_timeout 60s;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/meena-wa /etc/nginx/sites-enabled/meena-wa
nginx -t && systemctl reload nginx
certbot --nginx -d wa.example.com
```

4) Point Meena at the HTTPS URL (Railway env), then redeploy:

```
WHATSAPP_NOTIFY_URL=https://wa.example.com/send
```

No domain? Cheapest safe alternative: keep `:3003` but firewall it to Railway's
egress only. Railway egress is not a fixed IP on the hobby plan, so a domain +
nginx + TLS is the reliable option.

## Notes

- The bridge auto-reconnects (rebuilds a fresh client) on disconnect, and survives
  stray promise rejections — no need to `node server.js` by hand. Use systemd only.
- WhatsApp Web is unofficial; a phone re-link (QR) may be needed occasionally.
  Check `curl /health` → `state:"qr"` means it needs a re-scan via the logs.
