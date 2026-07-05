#!/usr/bin/env bash
# endpoints-curl.sh — enumerate every Siratech API endpoint using ONLY curl + grep.
# No login, no node, no puppeteer: the Siratech web app's API paths are baked into its
# static JavaScript, which any machine that can reach the site (your KSA VPS) can GET.
# READ-ONLY — it only downloads the app's own static files.
#
#   bash endpoints-curl.sh
#
# Override the base if needed:  HIS_BASE=https://his.meena-health.com bash endpoints-curl.sh
set -u
BASE="${HIS_BASE:-https://his.meena-health.com}"
OUT="endpoints-from-js.txt"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "── Siratech endpoint scan (curl, read-only) — $BASE ──"
echo "Fetching the app index…"
curl -sk --max-time 30 "$BASE/" -o "$tmp/index.html" || { echo "✗ couldn't reach $BASE"; exit 1; }

# JS bundle filenames referenced by the SPA (main.<hash>.js, runtime, polyfills, chunks…)
grep -oE '[A-Za-z0-9_.-]+\.js' "$tmp/index.html" | sort -u > "$tmp/bundles.txt"
echo "Found $(wc -l < "$tmp/bundles.txt" | tr -d ' ') JS bundle(s). Downloading + scanning…"

# Pull each bundle and extract every  <module>-api/api/vN/<path>  string.
: > "$tmp/raw.txt"
while read -r js; do
  [ -z "$js" ] && continue
  curl -sk --max-time 40 "$BASE/$js" 2>/dev/null \
    | grep -oE '[A-Za-z][A-Za-z0-9-]*-api/api/v[0-9]+/[A-Za-z0-9_/.-]+' >> "$tmp/raw.txt"
done < "$tmp/bundles.txt"

sort -u "$tmp/raw.txt" > "$OUT"
N=$(wc -l < "$OUT" | tr -d ' ')

echo
echo "════════ $N distinct API endpoints ════════"
cat "$OUT"
echo
echo "──── grouped by API module ────"
sed -E 's#([A-Za-z0-9-]+-api)/api/v[0-9]+/.*#\1#' "$OUT" | sort | uniq -c | sort -rn
echo
echo "──── likely useful for radiology + labs ────"
grep -iE 'lab|hcg|pregn|result|investig|report|patient|order|radiolog|panel|emr' "$OUT" || echo "(none matched — send me the full list)"
echo
echo "Saved to: $(pwd)/$OUT   — send me this file."
