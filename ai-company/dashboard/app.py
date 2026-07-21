"""Real-time dashboard for the AI company — FastAPI web UI."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
import sqlite3
from base import get_db, get_latest_metrics
from config.settings import PRODUCT_NAME

app = FastAPI(title=f"{PRODUCT_NAME} — Company Dashboard")

def html_page(body: str) -> str:
    return f"""<!DOCTYPE html>
<html>
<head>
<title>{PRODUCT_NAME} Dashboard</title>
<meta charset="utf-8">
<meta http-equiv="refresh" content="60">
<style>
* {{margin:0;padding:0;box-sizing:border-box}}
body {{background:#0a0a0f;color:#f0f0f5;font-family:system-ui,sans-serif;padding:20px}}
h1 {{font-size:1.5rem;margin-bottom:20px;background:linear-gradient(135deg,#6366f1,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}}
h2 {{font-size:1rem;margin:20px 0 10px;opacity:0.6;text-transform:uppercase;letter-spacing:0.1em}}
.grid {{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:24px}}
.card {{background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.2);border-radius:12px;padding:16px}}
.num {{font-size:2rem;font-weight:800;color:#a5b4fc}}
.label {{font-size:0.75rem;opacity:0.5;margin-top:4px}}
table {{width:100%;border-collapse:collapse;font-size:0.8rem}}
th {{text-align:left;padding:8px;opacity:0.4;border-bottom:1px solid rgba(255,255,255,0.08)}}
td {{padding:8px;border-bottom:1px solid rgba(255,255,255,0.05);vertical-align:top}}
.badge {{display:inline-block;padding:2px 8px;border-radius:20px;font-size:0.7rem;font-weight:600}}
.badge-analytics {{background:rgba(99,102,241,0.2);color:#a5b4fc}}
.badge-pricing {{background:rgba(245,158,11,0.2);color:#fbbf24}}
.badge-marketing {{background:rgba(34,197,94,0.2);color:#4ade80}}
.badge-growth {{background:rgba(14,165,233,0.2);color:#38bdf8}}
.badge-design {{background:rgba(168,85,247,0.2);color:#d8b4fe}}
.badge-support {{background:rgba(239,68,68,0.2);color:#f87171}}
.badge-ceo {{background:rgba(255,255,255,0.15);color:white}}
</style>
</head>
<body>
{body}
</body>
</html>"""

@app.get("/", response_class=HTMLResponse)
def dashboard():
    m = get_latest_metrics()
    conn = get_db()

    logs = conn.execute(
        "SELECT agent, action, result, cost_usd, created_at FROM agent_logs ORDER BY created_at DESC LIMIT 30"
    ).fetchall()
    decisions = conn.execute(
        "SELECT agent, decision, rationale, created_at FROM decisions ORDER BY created_at DESC LIMIT 15"
    ).fetchall()
    content = conn.execute(
        "SELECT platform, content, created_at FROM content ORDER BY created_at DESC LIMIT 5"
    ).fetchall()
    cost_row = conn.execute(
        "SELECT SUM(cost_usd) as total FROM agent_logs WHERE created_at > datetime('now','-7 days')"
    ).fetchone()
    conn.close()

    total_cost = cost_row["total"] or 0

    metrics_html = f"""
<h1>🤖 {PRODUCT_NAME} — AI Company Dashboard</h1>
<p style="opacity:0.4;font-size:0.8rem;margin-bottom:20px">Auto-refreshes every 60 seconds</p>
<div class="grid">
  <div class="card"><div class="num">${m.get('mrr',0):.0f}</div><div class="label">MRR</div></div>
  <div class="card"><div class="num">{m.get('active_subscribers',0)}</div><div class="label">Subscribers</div></div>
  <div class="card"><div class="num">{m.get('visitors',0)}</div><div class="label">Visitors Today</div></div>
  <div class="card"><div class="num">{m.get('conversion_rate',0)}%</div><div class="label">Conversion Rate</div></div>
  <div class="card"><div class="num">{m.get('churn_count',0)}</div><div class="label">Churn (recent)</div></div>
  <div class="card"><div class="num">${total_cost:.4f}</div><div class="label">AI Cost (7d)</div></div>
</div>"""

    logs_html = "<h2>Agent Activity</h2><table><tr><th>Agent</th><th>Action</th><th>Result</th><th>Cost</th><th>Time</th></tr>"
    for log in logs:
        badge = f'<span class="badge badge-{log["agent"]}">{log["agent"]}</span>'
        logs_html += f'<tr><td>{badge}</td><td>{log["action"]}</td><td style="opacity:0.6;max-width:300px">{str(log["result"])[:120]}...</td><td>${log["cost_usd"] or 0:.5f}</td><td style="opacity:0.4">{log["created_at"][:16]}</td></tr>'
    logs_html += "</table>"

    decisions_html = "<h2>Decisions</h2><table><tr><th>Agent</th><th>Decision</th><th>Rationale</th><th>Time</th></tr>"
    for d in decisions:
        badge = f'<span class="badge badge-{d["agent"]}">{d["agent"]}</span>'
        decisions_html += f'<tr><td>{badge}</td><td>{d["decision"]}</td><td style="opacity:0.6">{(d["rationale"] or "")[:100]}</td><td style="opacity:0.4">{d["created_at"][:16]}</td></tr>'
    decisions_html += "</table>"

    content_html = "<h2>Content Queue</h2><table><tr><th>Platform</th><th>Content</th><th>Time</th></tr>"
    for c in content:
        content_html += f'<tr><td><span class="badge badge-marketing">{c["platform"]}</span></td><td style="opacity:0.7">{c["content"][:200]}...</td><td style="opacity:0.4">{c["created_at"][:16]}</td></tr>'
    content_html += "</table>"

    return html_page(metrics_html + logs_html + decisions_html + content_html)

@app.get("/api/metrics")
def api_metrics():
    return get_latest_metrics()

@app.get("/api/logs")
def api_logs():
    conn = get_db()
    rows = conn.execute("SELECT * FROM agent_logs ORDER BY created_at DESC LIMIT 50").fetchall()
    conn.close()
    return [dict(r) for r in rows]
