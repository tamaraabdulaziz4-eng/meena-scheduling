import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
PRODUCT_NAME = "ResumeAI"
PRODUCT_URL = os.getenv("PRODUCT_URL", "https://resumeai.app")
PRICE_SINGLE = 9
PRICE_MONTHLY = 19

# Models: use haiku for cheap tasks, sonnet for reasoning, opus for CEO
MODEL_CHEAP   = "claude-haiku-4-5-20251001"
MODEL_DEFAULT = "claude-sonnet-5"
MODEL_CEO     = "claude-sonnet-5"

DB_PATH = Path(__file__).parent.parent / "data" / "company.db"
LOG_DIR = Path(__file__).parent.parent / "logs"
LOG_DIR.mkdir(exist_ok=True)
