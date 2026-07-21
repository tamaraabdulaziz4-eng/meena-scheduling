import json
import sqlite3
import datetime
from pathlib import Path
from typing import Any
import anthropic
from config.settings import ANTHROPIC_API_KEY, DB_PATH, LOG_DIR

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

def get_db():
    DB_PATH.parent.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            visitors INTEGER DEFAULT 0,
            signups INTEGER DEFAULT 0,
            revenue_single REAL DEFAULT 0,
            revenue_monthly REAL DEFAULT 0,
            mrr REAL DEFAULT 0,
            active_subscribers INTEGER DEFAULT 0,
            churn_count INTEGER DEFAULT 0,
            support_tickets INTEGER DEFAULT 0,
            conversion_rate REAL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS agent_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent TEXT NOT NULL,
            action TEXT NOT NULL,
            result TEXT,
            tokens_used INTEGER DEFAULT 0,
            cost_usd REAL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS decisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent TEXT NOT NULL,
            decision TEXT NOT NULL,
            rationale TEXT,
            status TEXT DEFAULT 'pending',
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS content (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            platform TEXT,
            content TEXT NOT NULL,
            status TEXT DEFAULT 'draft',
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS pricing_tests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            variant TEXT NOT NULL,
            price_single REAL,
            price_monthly REAL,
            conversions INTEGER DEFAULT 0,
            visitors INTEGER DEFAULT 0,
            status TEXT DEFAULT 'active',
            created_at TEXT DEFAULT (datetime('now'))
        );
    """)
    conn.commit()
    conn.close()

def log_agent(agent: str, action: str, result: Any, tokens: int = 0, cost: float = 0):
    conn = get_db()
    conn.execute(
        "INSERT INTO agent_logs (agent, action, result, tokens_used, cost_usd) VALUES (?,?,?,?,?)",
        (agent, action, str(result)[:2000], tokens, cost)
    )
    conn.commit()
    conn.close()
    log_file = LOG_DIR / f"{agent}.log"
    with open(log_file, "a") as f:
        f.write(f"[{datetime.datetime.now().isoformat()}] {action}: {str(result)[:500]}\n")

def ask_claude(prompt: str, model: str, system: str = "", max_tokens: int = 2048) -> tuple[str, int, float]:
    msgs = [{"role": "user", "content": prompt}]
    kwargs = {"model": model, "max_tokens": max_tokens, "messages": msgs}
    if system:
        kwargs["system"] = system
    response = client.messages.create(**kwargs)
    text = response.content[0].text
    tokens = response.usage.input_tokens + response.usage.output_tokens
    # Approximate cost: haiku ~$0.001/1k, sonnet ~$0.015/1k
    cost = tokens * (0.000001 if "haiku" in model else 0.000015)
    return text, tokens, cost

def get_latest_metrics() -> dict:
    conn = get_db()
    row = conn.execute("SELECT * FROM metrics ORDER BY date DESC LIMIT 1").fetchone()
    conn.close()
    if row:
        return dict(row)
    return {"visitors": 0, "signups": 0, "mrr": 0, "active_subscribers": 0,
            "revenue_single": 0, "churn_count": 0, "conversion_rate": 0}

def save_decision(agent: str, decision: str, rationale: str):
    conn = get_db()
    conn.execute("INSERT INTO decisions (agent, decision, rationale) VALUES (?,?,?)",
                 (agent, decision, rationale))
    conn.commit()
    conn.close()
