#!/usr/bin/env bash
# Phase 2: bind the bridge to localhost only and block the public :3003 port.
# Run this ONLY after harden.sh succeeded AND the app (Railway) is pointed at
# https://<domain>/send and notifications are confirmed working — otherwise
# notifications will stop until you switch the URL.
set -euo pipefail

echo "→ Binding the bridge to 127.0.0.1 and closing :3003 to the internet…"

mkdir -p /etc/systemd/system/meena-whatsapp.service.d
cat >/etc/systemd/system/meena-whatsapp.service.d/override.conf <<'EOF'
[Service]
Environment=BRIDGE_HOST=127.0.0.1
EOF

systemctl daemon-reload
systemctl restart meena-whatsapp
sleep 4

ufw deny 3003/tcp || true
ufw reload || true

echo
echo "✓ Locked down. The bridge now listens on localhost only and is reachable"
echo "  exclusively through nginx (HTTPS)."
echo
echo "Verify:"
echo "  curl -s http://127.0.0.1:3003/health        # should work (local)"
echo "  curl -s https://YOUR_DOMAIN/health          # should work (via nginx)"
echo "  curl -s --max-time 5 http://$(curl -s ifconfig.me):3003/health  # should now FAIL/refuse"
echo
echo "If anything looks wrong, undo with:"
echo "  rm /etc/systemd/system/meena-whatsapp.service.d/override.conf"
echo "  systemctl daemon-reload && systemctl restart meena-whatsapp && ufw allow 3003/tcp"
