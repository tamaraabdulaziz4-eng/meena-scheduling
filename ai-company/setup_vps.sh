#!/bin/bash
# ============================================================
#  ResumeAI — AI Company VPS Setup
#  Tested on: Ubuntu 22.04 LTS
#  Run as root: sudo bash setup_vps.sh
# ============================================================
set -e

APP_DIR="/home/user/meena-scheduling/ai-company"
PYTHON="python3"

echo ""
echo "============================================================"
echo "  ResumeAI AI Company — VPS Setup"
echo "============================================================"
echo ""

# 1. System deps
apt-get update -qq
apt-get install -y python3-pip python3-venv redis-server nginx -qq

# 2. Python packages
pip3 install anthropic fastapi uvicorn apscheduler schedule requests \
     python-dotenv rich sqlite-utils redis 2>&1 | tail -3

# 3. Start Redis
systemctl enable redis-server
systemctl start redis-server
echo "✅ Redis running"

# 4. Agent daemon service
cat > /etc/systemd/system/resumeai-agents.service << SERVICE
[Unit]
Description=ResumeAI — AI Company Agents (CEO + 7 sub-agents)
After=network.target redis.service

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
ExecStart=${PYTHON} run_company.py --daemon
Restart=always
RestartSec=30
Environment=PYTHONPATH=${APP_DIR}:${APP_DIR}/agents
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SERVICE

# 5. Dashboard service
cat > /etc/systemd/system/resumeai-dashboard.service << SERVICE
[Unit]
Description=ResumeAI — Company Dashboard (port 8080)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
ExecStart=${PYTHON} run_company.py --dashboard
Restart=always
RestartSec=5
Environment=PYTHONPATH=${APP_DIR}:${APP_DIR}/agents
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SERVICE

# 6. Enable + start
systemctl daemon-reload
systemctl enable resumeai-agents resumeai-dashboard
systemctl start resumeai-agents resumeai-dashboard

echo ""
echo "============================================================"
echo "  ✅ Setup complete!"
echo ""
echo "  Services:"
echo "    Agents:    systemctl status resumeai-agents"
echo "    Dashboard: http://$(curl -s ifconfig.me 2>/dev/null || echo YOUR_VPS_IP):8080"
echo ""
echo "  Logs:"
echo "    journalctl -u resumeai-agents -f"
echo "    ls ${APP_DIR}/logs/"
echo ""
echo "  Run agents manually:"
echo "    cd ${APP_DIR} && python3 run_company.py"
echo "============================================================"
echo ""
