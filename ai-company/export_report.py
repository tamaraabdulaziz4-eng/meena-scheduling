"""Export the latest agent run to a human-readable markdown report in reports/."""
import datetime
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
sys.path.insert(0, str(pathlib.Path(__file__).parent / "agents"))

from base import get_db  # noqa: E402

REPORTS = pathlib.Path(__file__).parent / "reports"
REPORTS.mkdir(exist_ok=True)


def main():
    conn = get_db()
    today = datetime.date.today().isoformat()

    lines = [f"# AI Company — Daily Brief ({today})\n"]

    # Latest decisions per agent (what each agent decided today)
    decisions = conn.execute(
        "SELECT agent, decision, rationale, created_at FROM decisions ORDER BY created_at DESC LIMIT 40"
    ).fetchall()
    if decisions:
        lines.append("## Decisions\n")
        for d in decisions:
            lines.append(f"- **{d['agent']}**: {d['decision']}")
            if d["rationale"]:
                lines.append(f"  - _{d['rationale'][:400]}_")
        lines.append("")

    # Content the marketing agent produced (ready to post)
    try:
        content = conn.execute(
            "SELECT platform, body, status, created_at FROM content ORDER BY created_at DESC LIMIT 10"
        ).fetchall()
        if content:
            lines.append("## Marketing content (ready to post)\n")
            for c in content:
                lines.append(f"### {c['platform']} — {c['status']}")
                lines.append(f"{c['body']}\n")
    except Exception:
        pass

    # Recent agent activity log
    logs = conn.execute(
        "SELECT agent, action, created_at FROM agent_logs ORDER BY created_at DESC LIMIT 25"
    ).fetchall()
    if logs:
        lines.append("## Activity log\n")
        for lg in logs:
            lines.append(f"- `{lg['created_at']}` {lg['agent']} → {lg['action']}")
        lines.append("")

    conn.close()

    report = "\n".join(lines)
    (REPORTS / f"{today}.md").write_text(report, encoding="utf-8")
    (REPORTS / "latest.md").write_text(report, encoding="utf-8")
    print(f"Report written: reports/{today}.md ({len(report)} chars)")


if __name__ == "__main__":
    main()
