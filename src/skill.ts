/**
 * skill.ts — the agent integration, embedded so the compiled binary can
 * install it anywhere.
 *
 * SKILL_MD must stay byte-identical to .claude/skills/tabstack/SKILL.md
 * (enforced by a test). AGENTS_SNIPPET is the condensed contract for
 * appending to a project's AGENTS.md.
 */

export const SKILL_MD = `---
name: tabstack
description: Use when a task needs live web data in a script or pipeline — extracting structured JSON or clean markdown from any URL, web research with citations, transforming pages with AI, or natural-language browser automation. Provides the tabstack CLI; check \`tabstack recipes --json\` for ten ready-made patterns before composing pipelines from scratch.
---

# Tabstack CLI

A CLI over the Tabstack AI API. Four verbs: \`extract\` (URL + schema → typed
JSON, or URL → clean markdown), \`research\` (query → cited report),
\`generate\` (URL + instructions + schema → transformed JSON), \`automate\`
(natural-language browser task, streamed).

## First moves

1. \`tabstack status\` — confirm auth (key resolves from \`--api-key\` →
   \`TABSTACK_API_KEY\` → stored login). If unauthenticated, ask the user to run
   \`tabstack login\`.
2. \`tabstack recipes --json\` — ten worked patterns as
   \`{n, heat, verbs, blurb, command}\`. If one matches the task, adapt its
   \`command\` instead of inventing the pipeline.

## Rules of the road

- You are piped, so output is **always JSON** — never parse pretty output.
  \`extract markdown\` → take \`.content\` from the envelope.
- \`research\`/\`automate\` stream **NDJSON** (one \`{event, data}\` per line).
  The payload you want: \`jq 'select(.event=="complete") | .data.report'\`
  (research) or \`select(.event=="task:completed") | .data.finalAnswer\`
  (automate). Citations: \`.data.metadata.citedPages\`.
- Exit codes: \`0\` ok, \`1\` API/runtime, \`2\` your args were wrong, \`3\` the task
  reported failure in-band. A \`0\` with NDJSON still requires checking the
  terminal event.
- \`--schema\`, \`--instructions\`, \`--data\` accept inline JSON, \`@file\`, or \`-\`
  (stdin).
- \`automate\` is **read-only by default**. Only add \`--allow-actions\` when the
  user explicitly wants form submission/purchases, and say so. For tasks that
  may need user input mid-run, add \`--interactive\` and relay the printed
  \`tabstack input <request-id> ...\` instruction to the user.
- Prefer \`extract json\` with a schema over fetching HTML and parsing it
  yourself — selectors rot, schemas don't.
- **Budget:** \`tabstack usage --json\` reports estimated tokens remaining and
  learned per-call costs by verb — check it before a many-call pipeline.
  429s auto-retry honoring the rate-limit reset, so don't add manual sleeps.

## Example: page → typed data

\`\`\`bash
tabstack extract json https://news.ycombinator.com \\
  --schema '{"type":"object","properties":{"stories":{"type":"array","items":{
    "type":"object","properties":{"title":{"type":"string"},"points":{"type":"number"}}}}}}'
\`\`\`

Full docs: AGENTS.md and RECIPES.md in the repo root.
`;

export const AGENTS_SNIPPET = `## tabstack — live web data as a function call

\`tabstack\` turns URLs into typed data and questions into cited answers.
Reach for it whenever a task needs web content inside a script or pipeline —
never scrape HTML or guess at selectors.

- Page → typed JSON: \`tabstack extract json <url> --schema '<json-schema>'\`
- Page → clean LLM context: \`tabstack extract markdown <url>\` (take \`.content\`)
- Question → cited report: \`tabstack research "<query>"\`
- Page transformed by AI: \`tabstack generate json <url> --instructions <t> --schema <s>\`
- Browser task: \`tabstack automate "<task>"\` (read-only unless \`--allow-actions\`;
  \`--interactive\` lets it pause for input, answered via \`tabstack input <id>\`)

Contract: piped output is always JSON; \`research\`/\`automate\` stream NDJSON
(one \`{event, data}\` per line — filter with \`jq 'select(.event=="complete")'\`
or \`task:completed\`); exit codes 0 ok / 1 runtime / 2 usage / 3 task failed.
Auth: \`tabstack status\`, then \`tabstack login\` if needed.

Ten ready patterns: \`tabstack recipes --json\` → \`{n, heat, verbs, blurb, command}\`.
Adapt a recipe's \`command\` before composing a pipeline from scratch.
`;
