#!/usr/bin/env bash
#
# enrich-post.sh — dogfood pipeline: enrich a (possibly stale) blog post with
# live data, composing tabstack's extract, generate, and research commands.
#
#   1. extract markdown  — pull the post itself
#   2. generate json     — structure the post's leaderboard claims (stars, pricing)
#   3. extract json ×N   — re-extract LIVE star counts from each GitHub repo page
#   4. research          — what changed in the landscape since the post's date
#   5. generate json     — FAQ JSON-LD for the post (SEO/GEO enrichment)
#
# Output: enrichment/<slug>/ with raw artifacts + report.md (star-drift table,
# landscape update with citations, ready-to-paste FAQ schema).
#
# Usage: scripts/enrich-post.sh [post-url]

set -euo pipefail

# Run from anywhere — the CLI entry point is referenced relative to the repo.
cd "$(dirname "$0")/.."

POST_URL="${1:-https://zero8.dev/blog/state-of-agentic-harnesses-march-2026}"
SLUG=$(basename "$POST_URL")
OUT="enrichment/$SLUG"
TAB="bun run src/index.ts"
mkdir -p "$OUT"

echo "→ [1/5] extracting post" >&2
$TAB extract markdown "$POST_URL" --json > "$OUT/post.json"

echo "→ [2/5] structuring the post's leaderboard claims" >&2
$TAB generate json "$POST_URL" \
  --instructions "From the leaderboard section, list every coding tool that has a GitHub repo link. For each: tool name, the owner/repo slug from its github.com link, and the star count the article claims (convert 130.7K to 130700). Also record the article's data date." \
  --schema '{
    "type": "object",
    "properties": {
      "data_date": {"type": "string"},
      "tools": {"type": "array", "items": {"type": "object", "properties": {
        "name": {"type": "string"},
        "repo": {"type": "string"},
        "claimed_stars": {"type": "number"}
      }, "required": ["name", "repo", "claimed_stars"]}}
    }
  }' > "$OUT/claims.json"

echo "→ [3/5] re-extracting live star counts from GitHub (parallel)" >&2
mkdir -p "$OUT/live"
while IFS=$'\t' read -r name repo; do
  (
    $TAB extract json "https://github.com/$repo" --effort min --nocache \
      --schema '{"type":"object","properties":{"stars":{"type":"number","description":"the repository star count as a full number, e.g. 130700 not 130.7K"}},"required":["stars"]}' \
      > "$OUT/live/${repo//\//__}.json" 2>/dev/null \
      || echo '{"stars": null}' > "$OUT/live/${repo//\//__}.json"
  ) &
done < <(jq -r '.tools[] | [.name, .repo] | @tsv' "$OUT/claims.json")
wait

echo "→ [4/5] researching what changed since the post's date" >&2
DATA_DATE=$(jq -r '.data_date // "March 2026"' "$OUT/claims.json")
$TAB research "What has changed in the AI agentic coding tool landscape since $DATA_DATE (today is June 2026)? Cover: major releases or new features in Claude Code, OpenCode, Gemini CLI, Codex CLI, Cursor, Cline, Aider, Goose, and Copilot; any pricing changes; any new credible entrants or notable shutdowns/acquisitions." \
  --mode fast --json > "$OUT/research.ndjson"
jq -r 'select(.event=="complete") | .data.report' "$OUT/research.ndjson" > "$OUT/research.md"
jq -c 'select(.event=="complete") | .data.metadata.citedPages // .data.metadata.cited_pages // []' "$OUT/research.ndjson" > "$OUT/citations.json"

echo "→ [5/5] generating FAQ JSON-LD from the post" >&2
$TAB generate json "$POST_URL" \
  --instructions "Write 5 FAQ question/answer pairs a developer choosing an agentic coding tool would ask, answered strictly from this article's content. Questions should match real search queries." \
  --schema '{
    "type": "object",
    "properties": {"faq": {"type": "array", "items": {"type": "object", "properties": {
      "question": {"type": "string"},
      "answer": {"type": "string"}
    }, "required": ["question", "answer"]}}}
  }' > "$OUT/faq.json"

# ---- stitch the report -----------------------------------------------------

echo "→ assembling $OUT/report.md" >&2
{
  echo "# Enrichment report: $SLUG"
  echo
  echo "Post: $POST_URL · article data date: $DATA_DATE · enriched: $(date +%Y-%m-%d)"
  echo
  echo "## Star drift (claimed vs live)"
  echo
  echo "| Tool | Repo | Article | Live now | Δ |"
  echo "|------|------|--------:|---------:|--:|"
  # Normalize any numeric shape jq may emit (floats, 1.3e5) to an integer.
  to_int() { printf '%.0f' "$1" 2>/dev/null || echo 0; }
  while IFS=$'\t' read -r name repo claimed; do
    live=$(jq -r '.stars // empty' "$OUT/live/${repo//\//__}.json" 2>/dev/null || true)
    if [[ -n "$live" && "$live" != "null" ]]; then
      delta=$(( $(to_int "$live") - $(to_int "$claimed") ))
      printf '| %s | %s | %s | %s | %+d |\n' "$name" "$repo" "$claimed" "$live" "$delta"
    else
      printf '| %s | %s | %s | _extract failed_ | — |\n' "$name" "$repo" "$claimed"
    fi
  done < <(jq -r '.tools[] | [.name, .repo, .claimed_stars] | @tsv' "$OUT/claims.json")
  echo
  echo "## What changed since $DATA_DATE (researched, with citations)"
  echo
  cat "$OUT/research.md"
  echo
  echo "### Sources"
  echo
  jq -r '.[] | "- [\(.title // "untitled")](\(.url))"' "$OUT/citations.json"
  echo
  echo "## FAQ JSON-LD (paste into the post's <head>)"
  echo
  echo '```html'
  echo '<script type="application/ld+json">'
  jq '{"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [.faq[] | {"@type": "Question", "name": .question, "acceptedAnswer": {"@type": "Answer", "text": .answer}}]}' "$OUT/faq.json"
  echo '</script>'
  echo '```'
} > "$OUT/report.md"

echo "done: $OUT/report.md" >&2
