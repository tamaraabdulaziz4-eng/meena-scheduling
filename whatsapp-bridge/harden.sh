#!/usr/bin/env bash
# Phase 1: put nginx + a real TLS cert in front of the WhatsApp bridge.
# The bridge stays reachable as before during this phase, so notifications
# don't break. After you confirm HTTPS works and switch the app over, run
# lockdown.sh to close the raw :3003 port.
#
# Prerequisite: a domain (or free subdomain, e.g. DuckDNS) whose A record points
# to THIS server's public IP.
#
# Usage:  bash harden.sh <domain> [email]
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-admin@${DOMAIN:-example.com}}"
if [ -z "$DOMAIN" ]; then
  echo "Usage: bash harden.sh <domain> [email]"
  echo "  e.g. bash harden.sh wa.mydomain.com me@mydomain.com"
  exit 1
fi

IP="$(curl -s --max-time 5 ifconfig.me || echo '?')"
echo "→ Domain : $DOMAIN"
echo "→ Server : $IP   (the domain's A record MUST point here)"
echo

apt-get update -y
apt-get install -y nginx certbot python3-certbot-nginx ufw

# Reverse proxy → the bridge on localhost. certbot will add the TLS block.
cat >/etc/nginx/sites-available/meena-wa <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};
    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_connect_timeout 10s;
        proxy_read_timeout 60s;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/meena-wa /etc/nginx/sites-enabled/meena-wa
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# Open the web ports + SSH (leave :3003 alone for now — lockdown.sh closes it).
ufw allow 22/tcp || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
ufw --force enable || true

# Obtain + install the Let's Encrypt certificate and force HTTPS.
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect
systemctl reload nginx

echo
echo "✓ nginx + TLS are ready."
echo "  Test now:   curl -s https://${DOMAIN}/health"
echo
echo "NEXT STEPS (in order — this is the safe cutover):"
echo "  1) In Railway set:   WHATSAPP_NOTIFY_URL=https://${DOMAIN}/send   then redeploy."
echo "  2) Confirm a test WhatsApp notification still arrives."
echo "  3) Then run:         bash lockdown.sh"
echo "     (binds the bridge to localhost and blocks the public :3003 port)"
