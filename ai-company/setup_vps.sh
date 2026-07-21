#!/bin/bash
# VPS Setup Script — run once on your server
set -e

echo "=== ResumeAI Company Agent Setup ==="

# Install Python deps
pip install anthropic fastapi uvicorn apscheduler schedule requests python-dotenv rich sqlite-utils

# Create systemd service for the agents (daemon)
cat > /etc/systemd/system/resumeai-agents.service << 'SERVICE'
[Unit]
Description=ResumeAI AI Company Agents
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/home/user/meena-scheduling/ai-company
ExecStart=/usr/bin/python3 run_company.py --daemon
Restart=always
RestartSec=10
Environment=PYTHONPATH=/home/user/meena-scheduling/ai-company

[Install]
WantedBy=multi-user.target
SERVICE

# Create systemd service for the dashboard
cat > /etc/systemd/system/resumeai-dashboard.service << 'SERVICE'
[Unit]
Description=ResumeAI Company Dashboard
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/home/user/meena-scheduling/ai-company
ExecStart=/usr/bin/python3 run_company.py --dashboard
Restart=always
RestartSec=5
Environment=PYTHONPATH=/home/user/meena-scheduling/ai-company

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable resumeai-agents resumeai-dashboard
systemctl start resumeai-agents resumeai-dashboard

echo ""
echo "✅ Done! Services running:"
echo "   Agents:    systemctl status resumeai-agents"
echo "   Dashboard: http://YOUR_VPS_IP:8080"
