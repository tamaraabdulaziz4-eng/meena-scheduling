#!/usr/bin/env python3
"""
Main entry point — runs the AI company.
Usage:
  python run_company.py          # Run CEO + all agents once
  python run_company.py --daemon # Run on schedule (CEO daily at 8am, marketing daily, etc.)
  python run_company.py --dashboard # Start web dashboard only
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'agents'))

from base import init_db

def run_once():
    init_db()
    from agents.ceo_agent import run as ceo_run
    ceo_run()

def run_daemon():
    from apscheduler.schedulers.blocking import BlockingScheduler
    from apscheduler.triggers.cron import CronTrigger
    import agents.analytics_agent as analytics
    import agents.marketing_agent as marketing
    import agents.ceo_agent as ceo

    init_db()
    scheduler = BlockingScheduler(timezone="UTC")

    # CEO + all agents: daily at 08:00 UTC
    scheduler.add_job(ceo.run, CronTrigger(hour=8, minute=0), id="ceo_daily", name="CEO Daily Brief")
    # Marketing: also runs at noon for extra content
    scheduler.add_job(marketing.run, CronTrigger(hour=12, minute=0), id="marketing_noon", name="Marketing Noon")
    # Analytics snapshot every 6 hours
    scheduler.add_job(analytics.run, CronTrigger(hour="*/6"), id="analytics_6h", name="Analytics 6h")

    print("🤖 AI Company running on schedule:")
    print("   CEO (all agents): daily 08:00 UTC")
    print("   Marketing:        daily 12:00 UTC")
    print("   Analytics:        every 6 hours")
    print("\nPress Ctrl+C to stop.\n")

    try:
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        print("Scheduler stopped.")

def run_dashboard():
    import uvicorn
    uvicorn.run("dashboard.app:app", host="0.0.0.0", port=8080, reload=False)

if __name__ == "__main__":
    if "--daemon" in sys.argv:
        run_daemon()
    elif "--dashboard" in sys.argv:
        run_dashboard()
    else:
        run_once()
