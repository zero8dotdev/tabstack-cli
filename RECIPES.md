# The Web Is a Function Call: Ten Recipes

For thirty years, the deal with search engines was: you type, they list, you click, you read, you copy. Every integration with the web's knowledge went through a human doing ctrl+C at the end of it.

That deal is over. Programmable search engines don't return ten blue links. They return *answers with citations*, *JSON shaped like your schema*, or *a finished browser session*. The web stopped being a place you visit and became a standard library you call.

Four primitives cover almost everything:

- **`extract(url, schema)`** — any page in, your types out. The web as a database you never have to ETL.
- **`research(query)`** — multi-source search that reads the results for you and returns a synthesized answer with cited sources. Search that shows its work.
- **`generate(url, instructions, schema)`** — fetch a page and transform it: summarize, classify, translate, grade.
- **`automate(task)`** — a browser that browses for you, streaming progress events, pausing to ask when it needs a human.

Everything below runs on those four verbs through this CLI. Data to stdout, progress to stderr, JSON when piped — so everything composes with `jq`, `cron`, and `&&`.

## What changes when search is programmable

**The web becomes typed.** The biggest tax on web data was never fetching it — it was parsing it. Selectors break, layouts shift, scrapers rot. Schema-shaped extraction inverts the contract: you declare the output type, the engine figures out the page. When the page redesigns, your schema doesn't care.

**Citations become data.** Research APIs return sources as structured fields, not vibes. That means you can *require* them — fail a pipeline when a claim has no source, diff citations between runs, build docs that link their evidence. The difference between an LLM that sounds right and a pipeline that is right is a `citedPages` array you can assert on.

**Content rot becomes measurable.** Eleven weeks after [a comparison of agentic coding tools](https://zero8.dev/blog/state-of-agentic-harnesses-march-2026) was published, an enrichment pipeline re-extracted every number in it. The fastest-moving row had drifted 59%. Two products had been renamed. The [June follow-up](https://zero8.dev/blog/state-of-agentic-harnesses-june-2026) was largely *written from the diff*. Static content decays at a knowable rate now — which means you can budget for it, monitor it, and automate the refresh.

**Agents finally get clean input.** A raw page is 400KB of div soup; the markdown extraction is 4KB of signal. If you're feeding web content to an LLM, that's a 100× token difference *before* you've done anything clever. Clean markdown in, structured JSON out is the whole game for agent context.

**The last mile gets a protocol.** Automation APIs stream progress as events and pause mid-task to request human input — form values, a confirmation, a decline — then resume. Human-in-the-loop stops being a TODO comment and becomes an event type you handle.

## Ten recipes, light to hard

Warm-ups first, then things you can put in CI, then things that will make your coworkers ask what exactly it is you do all day.

### 🟢 Light

**1. Hacker News, but typed.** The front page as a typed feed, no RSS, no parser.

```bash
tabstack extract json https://news.ycombinator.com \
  --schema '{"type":"object","properties":{"stories":{"type":"array","items":{
    "type":"object","properties":{"title":{"type":"string"},
    "url":{"type":"string"},"points":{"type":"number"}}}}}}' \
  | jq -r '.stories[:5][] | "\(.points)▲  \(.title)"'
```

**2. Docs → context.** Any docs page as clean markdown, straight into your prompt, your clipboard, or your agent's context window.

```bash
tabstack extract markdown https://bun.sh/docs/api/spawn | jq -r .content | pbcopy
```

**3. The price tag.** Exit non-zero when the thing you want drops below your number. Cron it and let `&&` do the notifying.

```bash
tabstack extract json "$PRODUCT_URL" \
  --schema '{"type":"object","properties":{"price":{"type":"number"}}}' \
  | jq -e '.price < 499' && open "$PRODUCT_URL"
```

**4. Changelog roulette.** Before you bump that dependency: fetch its releases page and ask the one question you actually have.

```bash
tabstack generate json https://github.com/sveltejs/kit/releases \
  --instructions "I'm on @sveltejs/kit 2.x using adapter-cloudflare. Anything in recent releases that breaks me?" \
  --schema '{"type":"object","properties":{"breaking":{"type":"boolean"},
    "verdict":{"type":"string"},"releases_checked":{"type":"array","items":{"type":"string"}}}}' \
  | jq -r '.verdict'
```

### 🟡 Medium

**5. The star drift detector.** Re-extract every number a page claims and diff against reality. This is [a real script](./scripts/enrich-post.sh) — it caught a 59% drift in a published post.

```bash
for repo in anthropics/claude-code anomalyco/opencode openai/codex; do
  echo "$repo: $(tabstack extract json "https://github.com/$repo" \
    --schema '{"type":"object","properties":{"stars":{"type":"number"}}}' \
    | jq .stars)"
done
```

**6. The citation machine.** Architecture decisions with receipts. Research streams NDJSON when piped — one event per line — so `jq` can split the report from its sources.

```bash
tabstack research "CRDTs vs operational transforms for a collaborative editor in 2026" \
  > /tmp/r.ndjson
jq -r 'select(.event=="complete") | .data.report' /tmp/r.ndjson > docs/adr/007-crdts.md
jq -r 'select(.event=="complete") | .data.metadata.citedPages[] | "- [\(.title)](\(.url))"' \
  /tmp/r.ndjson >> docs/adr/007-crdts.md
```

**7. CI for facts.** Your landing page says "trusted by 500+ teams" and "sub-100ms p99." Are those still true? A weekly GitHub Action that extracts your own claims and fails the build on drift. Content rot, caught like a failing test.

```bash
tabstack generate json https://yoursite.com \
  --instructions "List every quantitative claim on this page (numbers, counts, latencies) with its exact text." \
  --schema '{"type":"object","properties":{"claims":{"type":"array","items":{
    "type":"object","properties":{"text":{"type":"string"},"value":{"type":"number"}}}}}}' \
  | jq -e '.claims | length > 0'
```

**8. The geo sleuth.** Same page, three countries, one diff. Pricing pages are rarely as global as they claim.

```bash
for cc in US GB IN; do
  tabstack extract json "$PRICING_URL" --geo "$cc" --nocache \
    --schema '{"type":"object","properties":{"pro_price":{"type":"string"}}}' \
    | jq -r "\"$cc: \" + .pro_price"
done
```

### 🔴 Hard

**9. Forms with a conscience.** Browser automation that fills a form from JSON — but read-only by default (the CLI injects a no-purchases guardrail unless you opt out), and when the agent hits a field it can't answer, it *pauses and asks you*. Answer from a second terminal; the stream resumes.

```bash
tabstack automate "register for the conference using my details" \
  --url "$CONF_URL" --data @me.json --allow-actions

# stream pauses: input requested (id: req-7f3a)…
tabstack input req-7f3a --data '{"fields":[{"ref":"dietary","value":"vegetarian"}]}'
```

**10. The blog post that fact-checks itself.** The full loop: a scheduled job re-extracts every claim in a published post, researches what changed, regenerates the drift table, and opens a PR when reality has moved more than your threshold. Extract → generate → research → report, composed in ~100 lines of shell. This isn't hypothetical — [the June edition of the harness comparison](https://zero8.dev/blog/state-of-agentic-harnesses-june-2026) was produced by exactly this pipeline, using [`scripts/enrich-post.sh`](./scripts/enrich-post.sh).

```bash
./scripts/enrich-post.sh https://yoursite.com/blog/your-stale-masterpiece
# → enrichment/<slug>/report.md: drift table, cited updates, FAQ JSON-LD
```

## The point

None of these recipes is about scraping. Scraping was adversarial — you against the markup. This is declarative: you describe the shape of the truth you need, and the engine deals with the web's mess. The interesting work moves up a level, to the questions you ask and the pipelines you compose.

The web was always the world's largest database. It just took thirty years to get a query language.
