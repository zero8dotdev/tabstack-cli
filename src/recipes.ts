/**
 * recipes.ts — the cookbook, embedded.
 *
 * `tabstack recipes` lists them; `tabstack recipes <n>` prints one with a
 * copy-paste-ready command. Mirrors RECIPES.md — update both together.
 */

export interface Recipe {
  n: number;
  heat: "light" | "medium" | "hard";
  name: string;
  verbs: string[];
  blurb: string;
  command: string;
}

export const RECIPES: Recipe[] = [
  {
    n: 1,
    heat: "light",
    name: "Hacker News, but typed",
    verbs: ["extract"],
    blurb: "The front page as a typed feed. No RSS, no parser, no BeautifulSoup.",
    command: `tabstack extract json https://news.ycombinator.com \\
  --schema '{"type":"object","properties":{"stories":{"type":"array","items":{
    "type":"object","properties":{"title":{"type":"string"},
    "url":{"type":"string"},"points":{"type":"number"}}}}}}' \\
  | jq -r '.stories[:5][] | "\\(.points)▲  \\(.title)"'`,
  },
  {
    n: 2,
    heat: "light",
    name: "Docs → context",
    verbs: ["extract"],
    blurb: "Any docs page as clean markdown — 4KB of signal instead of 400KB of div soup.",
    command: `tabstack extract markdown https://bun.sh/docs/api/spawn | jq -r .content | pbcopy`,
  },
  {
    n: 3,
    heat: "light",
    name: "The price tag",
    verbs: ["extract"],
    blurb: "An exit code that knows when to buy. jq -e exits non-zero when false; cron + && is the whole alerting system.",
    command: `tabstack extract json "$PRODUCT_URL" \\
  --schema '{"type":"object","properties":{"price":{"type":"number"}}}' \\
  | jq -e '.price < 499' && open "$PRODUCT_URL"`,
  },
  {
    n: 4,
    heat: "light",
    name: "Changelog roulette",
    verbs: ["generate"],
    blurb: "Before you bump that dependency: fetch its releases page and ask the one question you actually have.",
    command: `tabstack generate json https://github.com/sveltejs/kit/releases \\
  --instructions "I'm on @sveltejs/kit 2.x with adapter-cloudflare. Anything in recent releases that breaks me?" \\
  --schema '{"type":"object","properties":{"breaking":{"type":"boolean"},
    "verdict":{"type":"string"}}}' \\
  | jq -r '.verdict'`,
  },
  {
    n: 5,
    heat: "medium",
    name: "The star drift detector",
    verbs: ["extract"],
    blurb: "Re-extract every number a page claims and diff against reality. Caught a 59% drift in a real post.",
    command: `for repo in anthropics/claude-code anomalyco/opencode openai/codex; do
  echo "$repo: $(tabstack extract json "https://github.com/$repo" \\
    --schema '{"type":"object","properties":{"stars":{"type":"number"}}}' \\
    | jq .stars)"
done`,
  },
  {
    n: 6,
    heat: "medium",
    name: "The citation machine",
    verbs: ["research"],
    blurb: "Architecture decisions with receipts. Piped research is NDJSON — jq 'select(.event==...)' is your event handler.",
    command: `tabstack research "CRDTs vs operational transforms for a collaborative editor in 2026" \\
  > /tmp/r.ndjson
jq -r 'select(.event=="complete") | .data.report' /tmp/r.ndjson > docs/adr/007-crdts.md
jq -r 'select(.event=="complete") | .data.metadata.citedPages[] | "- [\\(.title)](\\(.url))"' \\
  /tmp/r.ndjson >> docs/adr/007-crdts.md`,
  },
  {
    n: 7,
    heat: "medium",
    name: "CI for facts",
    verbs: ["generate"],
    blurb: '"Trusted by 500+ teams." "Sub-100ms p99." Cool — assert it. A build that fails when your landing page lies.',
    command: `tabstack generate json https://yoursite.com \\
  --instructions "List every quantitative claim on this page (numbers, counts, latencies) with its exact text." \\
  --schema '{"type":"object","properties":{"claims":{"type":"array","items":{
    "type":"object","properties":{"text":{"type":"string"},"value":{"type":"number"}}}}}}' \\
  | jq -e '.claims | length > 0'`,
  },
  {
    n: 8,
    heat: "medium",
    name: "The geo sleuth",
    verbs: ["extract"],
    blurb: "Same pricing page, three countries, one diff. Rarely as global as it claims.",
    command: `for cc in US GB IN; do
  tabstack extract json "$PRICING_URL" --geo "$cc" --nocache \\
    --schema '{"type":"object","properties":{"pro_price":{"type":"string"}}}' \\
    | jq -r "\\"$cc: \\" + .pro_price"
done`,
  },
  {
    n: 9,
    heat: "hard",
    name: "Forms with a conscience",
    verbs: ["automate", "input"],
    blurb: "A browser that fills forms from JSON, can't buy anything unless you say so, and pauses to ask when stuck. Answer from a second terminal with 'tabstack input'.",
    command: `tabstack automate "register for the conference using my details" \\
  --url "$CONF_URL" --data @me.json --allow-actions --interactive

# stream pauses with a request id, then:
tabstack input <request-id> --data '{"fields":[{"ref":"dietary","value":"vegetarian"}]}'`,
  },
  {
    n: 10,
    heat: "hard",
    name: "The post that fact-checks itself",
    verbs: ["extract", "generate", "research"],
    blurb: "A scheduled job re-extracts every claim in a published post, researches what changed, and reports the drift. ~100 lines of shell: scripts/enrich-post.sh.",
    command: `./scripts/enrich-post.sh https://yoursite.com/blog/your-stale-masterpiece
# → enrichment/<slug>/report.md: drift table, cited updates, FAQ JSON-LD`,
  },
];

export const HEAT_BADGE: Record<Recipe["heat"], string> = {
  light: "🟢",
  medium: "🟡",
  hard: "🔴",
};
