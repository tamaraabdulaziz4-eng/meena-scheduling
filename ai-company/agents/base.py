import json
import sqlite3
import datetime
from pathlib import Path
from typing import Any
import os
import urllib.request
from config.settings import DB_PATH, LOG_DIR


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
    """LLM call via NVIDIA's free OpenAI-compatible API (model arg is ignored;
    NVIDIA_MODEL env or the default free model is used). Cost is $0."""
    key = os.environ.get("NVIDIA_API_KEY", "")
    if not key:
        raise RuntimeError("NVIDIA_API_KEY is not set")
    nmodel = os.environ.get("NVIDIA_MODEL", "nvidia/llama-3.3-nemotron-super-49b-v1")
    msgs = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}]
    body = json.dumps({"model": nmodel, "max_tokens": max_tokens,
                       "temperature": 0.4, "messages": msgs}).encode()
    req = urllib.request.Request(
        "https://integrate.api.nvidia.com/v1/chat/completions", data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=280) as resp:
        data = json.loads(resp.read())
    text = data["choices"][0]["message"]["content"]
    usage = data.get("usage", {})
    tokens = (usage.get("prompt_tokens", 0) or 0) + (usage.get("completion_tokens", 0) or 0)
    return text, tokens, 0.0

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
