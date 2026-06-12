# tabstack-cli — agent instructions

You are working with (or near) `tabstack`, a CLI for the Tabstack AI API:
structured extraction, AI transformation, cited web research, and browser
automation. It is designed to be driven by agents.

## When to reach for it

Any time a task needs **live web data inside a script or pipeline**:

- A page's content as data → `extract json <url> --schema <json-schema>`
- A page as clean LLM context → `extract markdown <url>` (4KB of signal, not 400KB of HTML)
- A question needing sourced answers → `research "<query>"` (returns report + cited pages)
- Transform/classify/grade a page → `generate json <url> --instructions <text> --schema <schema>`
- Click/fill/navigate something → `automate "<task>"` (streams progress)

Do not scrape HTML or guess at selectors — declare the output shape and let
the API handle the page.

## The contract (everything you need to know)

- **Piped output is JSON. Always.** You are piped, so you always get JSON —
  no flags needed. `extract markdown` gives `{url, content}`; take `.content`.
- **Streaming commands (`research`, `automate`) emit NDJSON** — one
  `{"event": ..., "data": ...}` per line. Filter with
  `jq 'select(.event=="complete")'` (research) or `task:completed` (automate).
- **Exit codes:** `0` ok · `1` runtime/API error · `2` you passed bad args ·
  `3` the task itself reported failure. Check them.
- **Auth:** key from `--api-key` flag → `TABSTACK_API_KEY` env → stored
  `tabstack login`. Run `tabstack status` to see how it resolves.
- **Safety:** `automate` is read-only by default (an injected guardrail).
  Destructive actions need explicit `--allow-actions`. Human-in-the-loop needs
  `--interactive`; answer pauses with `tabstack input <request-id> --data ...`.
- **Budget:** `tabstack usage --json` → estimated tokens remaining + learned
  per-verb cost. Check it before many-call pipelines. 429s auto-retry
  honoring the rate-limit reset — do not add manual sleeps or backoff.

## The cookbook is machine-readable

Ten worked patterns (typed feeds, price watch, citation-backed ADRs, CI
fact-checking, geo diffing, self-fact-checking content) ship inside the CLI:

```bash
tabstack recipes --json            # all ten: {n, heat, verbs, blurb, command}
tabstack recipes 7 --json | jq -r .command   # one runnable command
```

Before composing a pipeline from scratch, check whether a recipe already
matches the task — adapt its `command` rather than inventing the jq plumbing.
Prose versions with sample outputs: [RECIPES.md](./RECIPES.md).

## Repo conventions (if you are modifying this code)

- Bun + TypeScript, zero runtime deps. `bun test` (e2e against a mock server),
  `bun x -p typescript@5.7 tsc --noEmit`, `bun run build` for the binary.
- data → stdout, progress → stderr; keep that separation in any new command.
- New flags: add no-value flags to `BOOLEAN_FLAGS` in `src/index.ts` or
  positional parsing breaks.
- Request bodies: check field casing against the API — `geo_target` is snake,
  `maxIterations` is camel. The spec is the source of truth.
- Keep `src/recipes.ts` and `RECIPES.md` in sync when touching recipes.
- The skill is embedded in `src/skill.ts` (SKILL_MD) and must stay
  byte-identical to `.claude/skills/tabstack/SKILL.md` — a test enforces it.
