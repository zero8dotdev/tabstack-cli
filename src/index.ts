#!/usr/bin/env bun
/**
 * index.ts — Tabstack CLI entry point.
 *
 * A single subcommand router over the Tabstack AI API:
 *   extract markdown | extract json | generate json | research | automate
 *
 * Conventions (the "gold standard"):
 *   - data → stdout, progress/errors → stderr
 *   - every data command supports --json for machine-readable output
 *   - missing/invalid args print a "Usage:" line to stderr and exit 1
 *   - --help / --version are handled before any network or key lookup
 *   - one clean "Error: <message>" line on failure, non-zero exit
 */

import { getApiKey, ENDPOINTS } from "./config";
import { postJson, postStream, TabstackError, type SseEvent } from "./client";
import { json, progress, resolveJsonArg, resolveTextArg } from "./format";
import { login, logout } from "./auth";

// =============================================================================
// Arg parsing helpers
// =============================================================================

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/** Nth positional arg, skipping flags and their values. */
function getPositional(args: string[], index: number): string | undefined {
  let pos = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      // Boolean flags take no value; valued flags consume the next token.
      if (!BOOLEAN_FLAGS.has(args[i])) i++;
      continue;
    }
    if (pos === index) return args[i];
    pos++;
  }
  return undefined;
}

/** Flags that do NOT consume a following value. */
const BOOLEAN_FLAGS = new Set([
  "--json",
  "--nocache",
  "--allow-actions",
  "--no-browser",
  "--no-verify",
]);

/** Shared option builders. */
function commonExtractOpts(args: string[]) {
  const opts: Record<string, unknown> = {};
  const effort = getArg(args, "--effort");
  if (effort) opts.effort = effort;
  if (hasFlag(args, "--nocache")) opts.nocache = true;
  const geo = getArg(args, "--geo");
  if (geo) opts.geo_target = { country: geo };
  return opts;
}

// =============================================================================
// Help
// =============================================================================

const HELP = `
tabstack - CLI for the Tabstack AI web extraction, generation & automation API

Usage:
  tabstack <command> [options]

Commands:
  login                           Open the Tabstack console and store an API key
  logout                          Remove the stored API key
  extract markdown <url>          Fetch a page as clean markdown
  extract json <url> --schema S   Extract structured JSON matching a schema
  generate json <url> --schema S --instructions T
                                  AI-transform a page into JSON (summarize, classify, ...)
  research <query>                Multi-source autonomous research (streams progress)
  automate <task> [--url U]       Natural-language browser automation (streams progress)
  help                            Show this help
  version                         Show version

Global options:
  --json                          Machine-readable JSON output
  --api-key <key>                 Override the TABSTACK_API_KEY env var
  -h, --help                      Show this help
  -v, --version                   Show version

Extract / generate options:
  --schema <@file|-|inline>       JSON schema: a file (@schema.json), stdin (-), or inline JSON
  --instructions <@file|-|text>   (generate) how to transform the page
  --effort <min|standard|max>     Speed vs. capability (default: standard)
  --nocache                       Bypass cache, force a fresh fetch
  --geo <CC>                      Fetch from a country (ISO 3166-1 alpha-2, e.g. US, GB)

Research options:
  --mode <fast|balanced>          Depth vs. speed (default: fast; balanced needs a paid plan)
  --nocache                       Force fresh results
  --fetch-timeout <seconds>       Per-page fetch timeout

Automate options:
  --url <url>                     Starting URL for the task
  --data <@file|inline>           Context data (e.g. form fields) as JSON
  --guardrails <text>             Safety constraints (default: browse & extract only)
  --allow-actions                 Drop the default read-only guardrail (use with care)
  --max-iterations <n>            Max agent iterations (1-100, default: 50)
  --geo <CC>                      Browse from a country (ISO 3166-1 alpha-2)

Login options:
  --with-key <key>                Store this key directly (skip the browser/prompt)
  --no-browser                    Don't open the browser; just print the URL
  --no-verify                     Skip the test API call that validates the key

Auth (resolved in order):
  --api-key <key>  →  TABSTACK_API_KEY env  →  stored key from 'tabstack login'
  Run 'tabstack login' once, or create a key at https://console.tabstack.ai

Examples:
  tabstack login
  tabstack login --with-key ts_xxx --no-verify
  tabstack extract markdown https://example.com
  echo '{"type":"object","properties":{"title":{"type":"string"}}}' | \\
    tabstack extract json https://news.ycombinator.com --schema -
  tabstack extract json https://shop.example.com --schema @schema.json --effort max
  tabstack generate json https://blog.example.com/post --schema @s.json \\
    --instructions "Write a 2-sentence summary into 'summary'"
  tabstack research "approaches to browser automation for AI agents" --mode fast
  tabstack automate "find the top 3 trending repos and their stars" \\
    --url https://github.com/trending
`;

function version(): string {
  const pkg = require("../package.json");
  return `tabstack ${pkg.version}`;
}

// =============================================================================
// Commands
// =============================================================================

async function cmdExtract(args: string[]): Promise<void> {
  const sub = args[1];

  if (sub === "markdown") {
    const url = getPositional(args.slice(2), 0);
    if (!url) {
      console.error("Usage: tabstack extract markdown <url>");
      process.exit(1);
    }
    const apiKey = getApiKey(getArg(args, "--api-key"));
    const result = await postJson<{ url: string; content: string }>(
      ENDPOINTS.extractMarkdown,
      { url },
      apiKey,
    );
    if (hasFlag(args, "--json")) console.log(json(result));
    else console.log(result.content);
    return;
  }

  if (sub === "json") {
    const url = getPositional(args.slice(2), 0);
    const schemaArg = getArg(args, "--schema");
    if (!url || !schemaArg) {
      console.error("Usage: tabstack extract json <url> --schema <@file|-|inline> [--effort] [--nocache] [--geo CC]");
      process.exit(1);
    }
    const json_schema = await resolveJsonArg(schemaArg, "--schema");
    const apiKey = getApiKey(getArg(args, "--api-key"));
    const result = await postJson(
      ENDPOINTS.extractJson,
      { url, json_schema, ...commonExtractOpts(args) },
      apiKey,
    );
    console.log(json(result));
    return;
  }

  console.error("Usage: tabstack extract <markdown|json> <url> [options]");
  process.exit(1);
}

async function cmdGenerate(args: string[]): Promise<void> {
  const sub = args[1];
  if (sub !== "json") {
    console.error("Usage: tabstack generate json <url> --schema <...> --instructions <...>");
    process.exit(1);
  }
  const url = getPositional(args.slice(2), 0);
  const schemaArg = getArg(args, "--schema");
  const instructionsArg = getArg(args, "--instructions");
  if (!url || !schemaArg || !instructionsArg) {
    console.error("Usage: tabstack generate json <url> --schema <@file|-|inline> --instructions <@file|-|text> [--effort] [--nocache] [--geo CC]");
    process.exit(1);
  }
  const json_schema = await resolveJsonArg(schemaArg, "--schema");
  const instructions = await resolveTextArg(instructionsArg);
  const apiKey = getApiKey(getArg(args, "--api-key"));
  const result = await postJson(
    ENDPOINTS.generateJson,
    { url, json_schema, instructions, ...commonExtractOpts(args) },
    apiKey,
  );
  console.log(json(result));
}

async function cmdResearch(args: string[]): Promise<void> {
  const query = getPositional(args.slice(1), 0);
  if (!query) {
    console.error('Usage: tabstack research "<query>" [--mode fast|balanced] [--nocache] [--fetch-timeout <s>] [--json]');
    process.exit(1);
  }
  const apiKey = getApiKey(getArg(args, "--api-key"));
  const body: Record<string, unknown> = { query };
  const mode = getArg(args, "--mode");
  if (mode) body.mode = mode;
  if (hasFlag(args, "--nocache")) body.nocache = true;
  const fetchTimeout = getArg(args, "--fetch-timeout");
  if (fetchTimeout) body.fetch_timeout = Number(fetchTimeout);

  const wantJson = hasFlag(args, "--json");

  for await (const evt of postStream(ENDPOINTS.research, body, apiKey)) {
    switch (evt.event) {
      case "start":
        progress("· starting research");
        break;
      case "planning:start":
        progress("· planning searches");
        break;
      case "iteration:start":
        progress(`· iteration ${evt.data?.iteration ?? "?"}/${evt.data?.maxIterations ?? "?"}`);
        break;
      case "writing:start":
        progress("· writing report");
        break;
      case "complete": {
        if (wantJson) {
          console.log(json(evt.data));
        } else {
          console.log(evt.data?.report ?? "");
          const cited = evt.data?.metadata?.citedPages ?? evt.data?.metadata?.cited_pages ?? [];
          if (cited.length) {
            progress(`\nCited ${cited.length} source${cited.length === 1 ? "" : "s"}:`);
            for (const p of cited) progress(`  - ${p.title ?? "(untitled)"}: ${p.url}`);
          }
        }
        return;
      }
      case "error":
        throw new Error(evt.data?.error?.message ?? evt.data?.message ?? "research failed");
    }
  }
}

async function cmdAutomate(args: string[]): Promise<void> {
  const task = getPositional(args.slice(1), 0);
  if (!task) {
    console.error('Usage: tabstack automate "<task>" [--url <url>] [--guardrails <text>] [--max-iterations <n>] [--data <@file>] [--geo CC] [--json]');
    process.exit(1);
  }
  const apiKey = getApiKey(getArg(args, "--api-key"));
  const body: Record<string, unknown> = { task };
  const url = getArg(args, "--url");
  if (url) body.url = url;

  // Safe by default: read-only unless the user opts into actions.
  const guardrails = getArg(args, "--guardrails");
  if (guardrails) body.guardrails = guardrails;
  else if (!hasFlag(args, "--allow-actions"))
    body.guardrails = "browse and extract only; do not submit forms, make purchases, or modify data";

  const maxIter = getArg(args, "--max-iterations");
  if (maxIter) body.maxIterations = Number(maxIter);
  const dataArg = getArg(args, "--data");
  if (dataArg) body.data = await resolveJsonArg(dataArg, "--data");
  const geo = getArg(args, "--geo");
  if (geo) body.geoTarget = { country: geo };

  const wantJson = hasFlag(args, "--json");

  for await (const evt of postStream(ENDPOINTS.automate, body, apiKey)) {
    switch (evt.event) {
      case "agent:status":
        progress(`· ${evt.data?.message ?? ""}`);
        break;
      case "agent:action":
        progress(`· action: ${evt.data?.action ?? ""}${evt.data?.value ? ` (${evt.data.value})` : ""}`);
        break;
      case "browser:navigated":
        progress(`· navigated: ${evt.data?.url ?? ""}`);
        break;
      case "task:completed": {
        const answer = evt.data?.finalAnswer;
        if (wantJson) console.log(json(evt.data));
        else console.log(typeof answer === "string" ? answer : json(answer));
        return;
      }
      case "task:aborted":
        progress(`Aborted: ${evt.data?.reason ?? "unknown reason"}`);
        process.exit(1);
      // eslint-disable-next-line no-fallthrough
      case "error":
        throw new Error(
          (typeof evt.data?.error === "string" ? evt.data.error : evt.data?.error?.message) ??
            "automation failed",
        );
    }
  }
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    console.log(version());
    return;
  }

  // Auth commands don't need an existing key.
  if (command === "login") {
    await login({
      withKey: getArg(args, "--with-key"),
      openBrowser: !hasFlag(args, "--no-browser"),
      verify: !hasFlag(args, "--no-verify"),
    });
    return;
  }
  if (command === "logout") {
    logout();
    return;
  }

  // Each command validates its own args BEFORE resolving the API key, so a
  // usage mistake prints a Usage: line rather than an auth error.
  switch (command) {
    case "extract":
      await cmdExtract(args);
      break;
    case "generate":
      await cmdGenerate(args);
      break;
    case "research":
      await cmdResearch(args);
      break;
    case "automate":
      await cmdAutomate(args);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Run 'tabstack help' for usage.");
      process.exit(1);
  }
}

main().catch((err) => {
  if (err instanceof TabstackError) {
    console.error(`Error (${err.status}): ${err.message}`);
  } else {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
});
