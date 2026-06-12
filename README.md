# tabstack

A small, fast Bun CLI for the [Tabstack AI](https://docs.tabstack.ai) API —
turn any URL into clean markdown or structured JSON, transform pages with AI,
run autonomous multi-source research, and drive natural-language browser
automation. One binary, no SDK required.

> **Built live, on the call.** This CLI was written with
> [Claude Code](https://claude.com/claude-code) during Tessa's Tabstack
> livestream — start to published repo while the stream was still going.
> It came together fast for one reason: it follows a gold-standard CLI
> pattern I'd already honed on previous tools — data to **stdout**, progress
> to **stderr**, `--json` on every command, honest exit codes, `--help` that
> never touches the network. A CLI built that way works for humans *and*
> agents — which is exactly why an agent could build, test, and dogfood it
> in one sitting. Good conventions compound.

## What can it do?

```bash
# Turn any page into clean markdown — yes, even Product Hunt
tabstack extract markdown https://www.producthunt.com/products/tabstack

# Check how Tabstack's own launch is doing... using Tabstack
tabstack extract json https://www.producthunt.com/products/tabstack/launches \
  --schema '{"type":"object","properties":{"launches":{"type":"array","items":{
    "type":"object","properties":{"name":{"type":"string"},
    "upvotes":{"type":"number"},"comments":{"type":"number"}}}}}}'

# Settle the eternal argument, with citations
tabstack research "tabs vs spaces: what do the major style guides actually recommend?"

# Outsource your browsing to a browser that browses for you
tabstack automate "find the top 3 trending repos and their star counts" \
  --url https://github.com/trending

# Pipe it like any good Unix citizen — piped output is JSON automatically
tabstack extract markdown https://example.com | jq -r .content | wc -w
```

Fun fact: the Product Hunt example above is how this repo checked Tabstack's
launch stats during the stream. The snake ate its own tail and returned
valid JSON matching the schema.

Want more? **[RECIPES.md](./RECIPES.md)** has ten of these, light to hard —
from a typed Hacker News feed to CI that fails when your landing page lies,
to a blog post that fact-checks itself. They're also built into the CLI:

```bash
tabstack recipes        # browse the cookbook
tabstack recipes 9      # one recipe, copy-paste ready
tabstack recipes 9 --json | jq .command   # agents eat the cookbook too
```

## For agents

The skill ships inside the binary — anyone who installs the CLI can wire it
into their coding agent in one line:

```bash
tabstack skill install              # Claude Code, all sessions (~/.claude/skills)
tabstack skill install --project    # Claude Code, this repo only (.claude/skills)
tabstack skill agents >> AGENTS.md  # Codex, Cursor, Copilot, VS Code, …
tabstack skill                      # print it, pipe it anywhere else
```

Three discovery paths, so an agent finds the recipes however it arrives:

- **[AGENTS.md](./AGENTS.md)** — the agent contract: output conventions,
  NDJSON event filtering, exit codes, safety flags, and the recipe index.
  Read automatically by Codex, Cursor, Copilot, and friends.
- **The Claude Code skill** (above) — triggers when a task needs live web
  data, before the user mentions tabstack.
- **`tabstack recipes --json`** — the cookbook as structured data, no docs
  required.

## Install

```bash
bun install
bun link            # puts `tabstack` on your PATH (dev)
# or build a standalone binary:
bun run build       # → ./tabstack
```

Requires [Bun](https://bun.sh) ≥ 1.1.

## Auth

Easiest: log in once. This opens the Tabstack console so you can create/copy a
key, then stores it at `~/.config/tabstack/config.json` (mode `0600`).

```bash
tabstack login                              # opens the browser, prompts for the key
tabstack login --with-key ts_xxx            # non-interactive (CI)
echo "$KEY" | tabstack login --no-verify    # from a pipe
tabstack logout                             # remove the stored key
```

The key is resolved in this order:

```text
--api-key <key>   →   TABSTACK_API_KEY env   →   stored key from `tabstack login`
```

`export TABSTACK_API_KEY=...` or `--api-key` still work and take precedence.
Tabstack has no headless OAuth/device flow, so `login` just opens the console
(API Keys → Create New API Key) and securely saves what you paste. By default it
verifies the key with one cheap API call; skip that with `--no-verify`.

## Commands

```text
tabstack login                                         Open console & store an API key
tabstack logout                                        Remove the stored API key
tabstack status                                        How your key resolves (never prints it)
tabstack extract markdown <url> [--metadata]           Page → clean markdown
tabstack extract json <url> --schema S                 Page → JSON matching a schema
tabstack generate json <url> --schema S --instructions T   AI-transform a page → JSON
tabstack research "<query>"                            Multi-source research (streaming)
tabstack automate "<task>" [--url U]                   Browser automation (streaming)
tabstack input <request-id> --data D                   Answer a paused automation
tabstack recipes [n|name]                              The cookbook, in your terminal
```

Run `tabstack help` for the full flag reference.

### Extract

```bash
# Markdown to stdout
tabstack extract markdown https://example.com

# Structured JSON — schema from a file, stdin, or inline
tabstack extract json https://news.ycombinator.com --schema @schema.json
echo '{"type":"object","properties":{"title":{"type":"string"}}}' \
  | tabstack extract json https://example.com --schema -
tabstack extract json https://shop.example.com \
  --schema @products.json --effort max --nocache --geo GB
```

### Generate (AI transformation)

```bash
tabstack generate json https://blog.example.com/post \
  --schema @out.json \
  --instructions "Write a 2-sentence summary into 'summary' and classify 'sentiment'"
```

### Research (streaming)

Progress is printed to **stderr**; the final markdown report goes to **stdout**,
so you can redirect it cleanly. In JSON mode the stream is NDJSON, one event
per line.

```bash
tabstack research "approaches to browser automation for AI agents" --mode fast
tabstack research "EU vs US AI regulation" --mode balanced -o pretty > report.md
tabstack research "competitor pricing" \
  | jq -r 'select(.event=="complete") | .data.metadata.citedPages'
```

### Automate (streaming)

Read-only by default (a safe guardrail is applied unless you pass your own or
`--allow-actions`). Progress to stderr, the agent's final answer to stdout.

```bash
tabstack automate "find the top 3 trending repos and their star counts" \
  --url https://github.com/trending

tabstack automate "fill the contact form and submit" \
  --url https://co.example.com/contact \
  --data @form.json --allow-actions --max-iterations 30
```

Pass `--interactive` to let the agent pause and ask for input mid-task
(`interactive:form_data:request`) — the CLI prints the request id and how to
answer it:

```bash
tabstack input <request-id> --data '{"fields":[{"ref":"field1","value":"yes"}]}'
tabstack input <request-id> --data '{"cancelled":true}'    # decline
```

## Output conventions

- **stdout** — the data (markdown, JSON, report, final answer). Pipeable.
- **stderr** — progress, status, citations, errors.
- **Output mode** — pretty (human-readable) on a TTY, JSON when piped, so
  `tabstack ... | jq .` just works. Force with `-o pretty|json` (`--json` is
  shorthand for `-o json`). Streaming commands emit NDJSON in JSON mode.
  `extract json` and `generate json` print JSON in both modes — the JSON *is*
  the data.
- **Color** — disabled when piped, with `--no-color`, or via `NO_COLOR`.
- **exit code** — `0` success · `1` runtime/API error · `2` usage error ·
  `3` the task itself reported failure.
- **`--base-url <url>`** / `TABSTACK_BASE_URL` for self-hosted or staging;
  `--timeout <seconds>` for non-streaming calls.

## Endpoints used

| Command            | Endpoint                  | Transport |
| ------------------ | ------------------------- | --------- |
| `extract markdown` | `POST /v1/extract/markdown` | JSON      |
| `extract json`     | `POST /v1/extract/json`     | JSON      |
| `generate json`    | `POST /v1/generate/json`    | JSON      |
| `research`         | `POST /v1/research`         | SSE       |
| `automate`         | `POST /v1/automate`         | SSE       |
| `input`            | `POST /v1/automate/{id}/input` | JSON   |

## Develop

```bash
bun test                          # mock-server end-to-end tests (43 tests)
bun x -p typescript tsc --noEmit  # typecheck
bun run start --help
```

## Project layout

```text
src/
├── index.ts    # CLI entry + subcommand router (the gold-standard pattern)
├── config.ts   # base URL, key resolution, endpoint paths, credential storage
├── auth.ts     # login/logout: open console, read key, verify, store 0600
├── client.ts   # fetch wrapper: postJson + postStream (SSE) + TabstackError
└── format.ts   # json(), stderr progress(), schema/text arg resolution
test/
└── cli.test.ts # runs the real binary against a Bun.serve mock
```

## Notes

- `--schema` and `--data` accept `@file`, `-` (stdin), or inline JSON;
  `--instructions` accepts `@file`, `-`, or a literal string.
- `balanced` research mode requires a paid Tabstack plan.
- Feature parity with the official
  [Mozilla-Ocho/tabstack-cli](https://github.com/Mozilla-Ocho/tabstack-cli)
  (Go), plus three extras: safe-by-default `automate` guardrails, a
  browser-opening `login` that verifies the key before storing it, and a
  working human-in-the-loop flow — `automate --interactive` actually enables
  the API's input requests (the official CLI ships `agent input` but no way
  to turn interactive mode on).
