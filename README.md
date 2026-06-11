# tabstack

A small, fast Bun CLI for the [Tabstack AI](https://docs.tabstack.ai) API —
turn any URL into clean markdown or structured JSON, transform pages with AI,
run autonomous multi-source research, and drive natural-language browser
automation. One binary, no SDK required.

Built to the same CLI conventions as `smriti`: a subcommand router, `--json`
on every data command, data to stdout / progress to stderr, honest exit codes,
and `--help` / `--version` that never touch the network.

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
tabstack extract markdown <url>                        Page → clean markdown
tabstack extract json <url> --schema S                 Page → JSON matching a schema
tabstack generate json <url> --schema S --instructions T   AI-transform a page → JSON
tabstack research "<query>"                            Multi-source research (streaming)
tabstack automate "<task>" [--url U]                   Browser automation (streaming)
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
so you can redirect it cleanly. `--json` emits the full `complete` payload.

```bash
tabstack research "approaches to browser automation for AI agents" --mode fast
tabstack research "EU vs US AI regulation" --mode balanced > report.md
tabstack research "competitor pricing" --json | jq .metadata.citedPages
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

## Output conventions

- **stdout** — the data (markdown, JSON, report, final answer). Pipeable.
- **stderr** — progress, status, citations, errors.
- **`--json`** — machine-readable JSON on every data command.
- **exit code** — `0` on success, `1` on any error (usage, auth, or API).

## Endpoints used

| Command            | Endpoint                  | Transport |
| ------------------ | ------------------------- | --------- |
| `extract markdown` | `POST /v1/extract/markdown` | JSON      |
| `extract json`     | `POST /v1/extract/json`     | JSON      |
| `generate json`    | `POST /v1/generate/json`    | JSON      |
| `research`         | `POST /v1/research`         | SSE       |
| `automate`         | `POST /v1/automate`         | SSE       |

## Develop

```bash
bun test            # mock-server end-to-end tests
bun x tsc --noEmit  # typecheck
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
- `automate` interactive (human-in-the-loop) form filling is not wired into
  this CLI yet; runs are non-interactive.
