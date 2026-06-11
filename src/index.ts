#!/usr/bin/env bun
/**
 * index.ts — Tabstack CLI entry point.
 *
 * A single subcommand router over the Tabstack AI API:
 *   extract markdown | extract json | generate json | research | automate | input | status
 *
 * Conventions (the "gold standard", matching the official Go CLI):
 *   - data → stdout, progress/errors → stderr
 *   - output is pretty on a TTY and JSON when piped; force with -o pretty|json
 *     (streaming commands emit one NDJSON line per event in JSON mode)
 *   - exit codes: 0 ok, 1 runtime/API error, 2 usage error, 3 task reported failure
 *   - --help / --version are handled before any network or key lookup
 *   - one clean "Error: <message>" line on failure
 */

import { getApiKey, resolveKey, getBaseUrl, setBaseUrl, ENDPOINTS, CONFIG_FILE } from "./config";
import { postJson, postStream, setRequestTimeout, TabstackError } from "./client";
import {
  json,
  ndjson,
  progress,
  green,
  disableColor,
  resolveMode,
  resolveJsonArg,
  resolveTextArg,
  UsageError,
  type OutputMode,
} from "./format";
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
    // A bare "-" is a value (stdin), not a flag.
    if (args[i].length > 1 && args[i].startsWith("-")) {
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
  "--metadata",
  "--allow-actions",
  "--no-browser",
  "--no-verify",
  "--no-color",
  "-h",
  "--help",
  "-v",
  "--version",
]);

/** Fail with a usage message (printed to stderr, exit 2). */
function usage(message: string): never {
  throw new UsageError(message);
}

/**
 * Apply global flags (--base-url, --timeout, --no-color) and resolve the
 * output mode. Called once before any command runs.
 */
function setupGlobals(args: string[]): OutputMode {
  if (hasFlag(args, "--no-color")) disableColor();
  const baseUrl = getArg(args, "--base-url");
  if (baseUrl) setBaseUrl(baseUrl);
  const timeout = getArg(args, "--timeout");
  if (timeout) {
    const secs = Number(timeout);
    if (!Number.isFinite(secs) || secs <= 0) usage(`--timeout must be a positive number of seconds (got "${timeout}")`);
    setRequestTimeout(secs);
  }
  return resolveMode(getArg(args, "-o") ?? getArg(args, "--output"), hasFlag(args, "--json"));
}

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
  status                          Show how your API key is being resolved (never prints it)
  extract markdown <url>          Fetch a page as clean markdown
  extract json <url> --schema S   Extract structured JSON matching a schema
  generate json <url> --schema S --instructions T
                                  AI-transform a page into JSON (summarize, classify, ...)
  research <query>                Multi-source autonomous research (streams progress)
  automate <task> [--url U]       Natural-language browser automation (streams progress)
  input <request-id> --data D     Respond to a paused automation that asked for input
  help                            Show this help
  version                         Show version

Global options:
  -o, --output <pretty|json>      Output mode (default: pretty on a TTY, json when piped)
  --json                          Shorthand for -o json (streams emit NDJSON, one event/line)
  --api-key <key>                 Override the TABSTACK_API_KEY env var
  --base-url <url>                Override the API base URL (or TABSTACK_BASE_URL)
  --timeout <seconds>             Request timeout for non-streaming calls
  --no-color                      Disable colored output (NO_COLOR is also honored)
  -h, --help                      Show this help
  -v, --version                   Show version

Extract / generate options:
  --schema <@file|-|inline>       JSON schema: a file (@schema.json), stdin (-), or inline JSON
  --instructions <@file|-|text>   (generate) how to transform the page
  --metadata                      (extract markdown) include page metadata in the response
  --effort <min|standard|max>     Speed vs. capability (default: standard)
  --nocache                       Bypass cache, force a fresh fetch
  --geo <CC>                      Fetch from a country (ISO 3166-1 alpha-2, e.g. US, GB)

Research options:
  --mode <fast|balanced>          Depth vs. speed (default: fast; balanced needs a paid plan)
  --nocache                       Force fresh results
  --fetch-timeout <seconds>       Per-page fetch timeout

Automate options:
  --url <url>                     Starting URL for the task
  --data <@file|-|inline>         Context data (e.g. form fields) as JSON
  --guardrails <text>             Safety constraints (default: browse & extract only)
  --allow-actions                 Drop the default read-only guardrail (use with care)
  --max-iterations <n>            Max agent iterations (1-100, default: 50)
  --max-validation-attempts <n>   Max validation attempts (1-10)
  --geo <CC>                      Browse from a country (ISO 3166-1 alpha-2)

Input options (responding to a paused automation):
  --data <@file|-|inline>         {"fields":[{"ref":"...","value":"..."}]} or {"cancelled":true}

Login options:
  --with-key <key>                Store this key directly (skip the browser/prompt)
  --no-browser                    Don't open the browser; just print the URL
  --no-verify                     Skip the test API call that validates the key

Auth (resolved in order):
  --api-key <key>  →  TABSTACK_API_KEY env  →  stored key from 'tabstack login'
  Run 'tabstack login' once, or create a key at https://console.tabstack.ai

Exit codes:
  0 success · 1 runtime/API error · 2 usage error · 3 task reported failure

Examples:
  tabstack login
  tabstack login --with-key ts_xxx --no-verify
  tabstack extract markdown https://example.com --metadata
  tabstack extract markdown https://example.com | jq .
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

async function cmdExtract(args: string[], mode: OutputMode): Promise<void> {
  const sub = args[1];

  if (sub === "markdown") {
    const url = getPositional(args.slice(2), 0);
    if (!url) usage("Usage: tabstack extract markdown <url> [--metadata] [--effort] [--nocache] [--geo CC]");
    const body: Record<string, unknown> = { url, ...commonExtractOpts(args) };
    if (hasFlag(args, "--metadata")) body.metadata = true;
    const apiKey = getApiKey(getArg(args, "--api-key"));
    const result = await postJson<{ url: string; content: string; metadata?: unknown }>(
      ENDPOINTS.extractMarkdown,
      body,
      apiKey,
    );
    if (mode === "json") {
      console.log(json(result));
    } else {
      console.log(result.content);
      if (result.metadata !== undefined) console.log("\n" + json(result.metadata));
    }
    return;
  }

  if (sub === "json") {
    const url = getPositional(args.slice(2), 0);
    const schemaArg = getArg(args, "--schema");
    if (!url || !schemaArg) {
      usage("Usage: tabstack extract json <url> --schema <@file|-|inline> [--effort] [--nocache] [--geo CC]");
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

  usage("Usage: tabstack extract <markdown|json> <url> [options]");
}

async function cmdGenerate(args: string[]): Promise<void> {
  const sub = args[1];
  if (sub !== "json") usage("Usage: tabstack generate json <url> --schema <...> --instructions <...>");
  const url = getPositional(args.slice(2), 0);
  const schemaArg = getArg(args, "--schema");
  const instructionsArg = getArg(args, "--instructions");
  if (!url || !schemaArg || !instructionsArg) {
    usage("Usage: tabstack generate json <url> --schema <@file|-|inline> --instructions <@file|-|text> [--effort] [--nocache] [--geo CC]");
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

async function cmdResearch(args: string[], outMode: OutputMode): Promise<void> {
  const query = getPositional(args.slice(1), 0);
  if (!query) {
    usage('Usage: tabstack research "<query>" [--mode fast|balanced] [--nocache] [--fetch-timeout <s>]');
  }
  const apiKey = getApiKey(getArg(args, "--api-key"));
  const body: Record<string, unknown> = { query };
  const mode = getArg(args, "--mode");
  if (mode) body.mode = mode;
  if (hasFlag(args, "--nocache")) body.nocache = true;
  const fetchTimeout = getArg(args, "--fetch-timeout");
  if (fetchTimeout) body.fetch_timeout = Number(fetchTimeout);

  for await (const evt of postStream(ENDPOINTS.research, body, apiKey)) {
    if (outMode === "json") console.log(ndjson(evt.event, evt.data));
    switch (evt.event) {
      case "start":
        if (outMode === "pretty") progress("· starting research");
        break;
      case "planning:start":
        if (outMode === "pretty") progress("· planning searches");
        break;
      case "iteration:start":
        if (outMode === "pretty") progress(`· iteration ${evt.data?.iteration ?? "?"}/${evt.data?.maxIterations ?? "?"}`);
        break;
      case "writing:start":
        if (outMode === "pretty") progress("· writing report");
        break;
      case "complete": {
        if (outMode === "pretty") {
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
        // In-band failure from the stream → exit 3 (matches the official CLI).
        console.error(`Error: ${evt.data?.error?.message ?? evt.data?.message ?? "research failed"}`);
        process.exit(3);
    }
  }
}

async function cmdAutomate(args: string[], outMode: OutputMode): Promise<void> {
  const task = getPositional(args.slice(1), 0);
  if (!task) {
    usage('Usage: tabstack automate "<task>" [--url <url>] [--guardrails <text>] [--max-iterations <n>] [--max-validation-attempts <n>] [--data <@file>] [--geo CC]');
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
  if (maxIter) {
    const n = Number(maxIter);
    if (!Number.isInteger(n) || n < 1 || n > 100) usage(`--max-iterations must be between 1 and 100 (got ${maxIter})`);
    body.maxIterations = n;
  }
  const maxValidation = getArg(args, "--max-validation-attempts");
  if (maxValidation) {
    const n = Number(maxValidation);
    if (!Number.isInteger(n) || n < 1 || n > 10) usage(`--max-validation-attempts must be between 1 and 10 (got ${maxValidation})`);
    body.maxValidationAttempts = n;
  }
  const dataArg = getArg(args, "--data");
  if (dataArg) body.data = await resolveJsonArg(dataArg, "--data");
  const geo = getArg(args, "--geo");
  if (geo) body.geoTarget = { country: geo };

  for await (const evt of postStream(ENDPOINTS.automate, body, apiKey)) {
    if (outMode === "json") console.log(ndjson(evt.event, evt.data));
    switch (evt.event) {
      case "agent:status":
        if (outMode === "pretty") progress(`· ${evt.data?.message ?? ""}`);
        break;
      case "agent:action":
        if (outMode === "pretty") progress(`· action: ${evt.data?.action ?? ""}${evt.data?.value ? ` (${evt.data.value})` : ""}`);
        break;
      case "browser:navigated":
        if (outMode === "pretty") progress(`· navigated: ${evt.data?.url ?? ""}`);
        break;
      case "interactive:form_data:request": {
        // The agent paused for human input. Surface the request id and how to answer.
        const id = evt.data?.requestId ?? evt.data?.request_id ?? "<request-id>";
        progress(`· input requested (expires in ~2 minutes)`);
        progress(`  respond with: tabstack input ${id} --data '{"fields":[{"ref":"...","value":"..."}]}'`);
        progress(`  or decline:   tabstack input ${id} --data '{"cancelled":true}'`);
        break;
      }
      case "task:completed": {
        if (evt.data?.success === false) {
          console.error(`Error: automation reported failure${evt.data?.finalAnswer ? `: ${evt.data.finalAnswer}` : ""}`);
          process.exit(3);
        }
        if (outMode === "pretty") {
          const answer = evt.data?.finalAnswer;
          console.log(typeof answer === "string" ? answer : json(answer));
        }
        return;
      }
      case "task:aborted":
        console.error(`Error: aborted: ${evt.data?.reason ?? "unknown reason"}`);
        process.exit(3);
      // eslint-disable-next-line no-fallthrough
      case "error":
        console.error(
          `Error: ${(typeof evt.data?.error === "string" ? evt.data.error : evt.data?.error?.message) ?? "automation failed"}`,
        );
        process.exit(3);
    }
  }
}

/** `tabstack input <request-id> --data <...>` → POST /v1/automate/{id}/input. */
async function cmdInput(args: string[], outMode: OutputMode): Promise<void> {
  const requestId = getPositional(args.slice(1), 0);
  const dataArg = getArg(args, "--data");
  if (!requestId || !dataArg) {
    usage('Usage: tabstack input <request-id> --data <@file|-|inline>\n' +
      '  --data must be {"fields":[{"ref":"...","value":"..."}]} to answer, or {"cancelled":true} to decline');
  }
  const payload = (await resolveJsonArg(dataArg, "--data")) as {
    fields?: unknown[];
    cancelled?: boolean;
  };
  if (!payload || typeof payload !== "object" || (!Array.isArray(payload.fields) && payload.cancelled !== true)) {
    usage('--data must set "fields" (to submit values) or "cancelled":true (to decline)');
  }
  const apiKey = getApiKey(getArg(args, "--api-key"));
  await postJson(ENDPOINTS.automateInput(requestId), payload, apiKey);
  if (outMode === "json") console.log(json({ submitted: true }));
  else console.log(green("input submitted"));
}

/** `tabstack status` — how the key resolves, without ever printing it. */
function cmdStatus(args: string[], outMode: OutputMode): void {
  const resolved = resolveKey(getArg(args, "--api-key"));
  if (outMode === "json") {
    console.log(json({
      authenticated: Boolean(resolved),
      source: resolved?.source ?? null,
      configFile: CONFIG_FILE,
      baseUrl: getBaseUrl(),
    }));
    return;
  }
  if (!resolved) {
    console.log("No API key configured. Set one with 'tabstack login'.");
  } else {
    console.log(`${green("✓")} API key configured`);
    console.log(`source:   ${resolved.source}`);
  }
  console.log(`base url: ${getBaseUrl()}`);
  console.log(`config:   ${CONFIG_FILE}`);
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

  const outMode = setupGlobals(args);

  // Each command validates its own args BEFORE resolving the API key, so a
  // usage mistake prints a Usage: line rather than an auth error.
  switch (command) {
    case "status":
      cmdStatus(args, outMode);
      break;
    case "extract":
      await cmdExtract(args, outMode);
      break;
    case "generate":
      await cmdGenerate(args);
      break;
    case "research":
      await cmdResearch(args, outMode);
      break;
    case "automate":
      await cmdAutomate(args, outMode);
      break;
    case "input":
      await cmdInput(args, outMode);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Run 'tabstack help' for usage.");
      process.exit(1);
  }
}

main().catch((err) => {
  if (err instanceof UsageError) {
    console.error(err.message);
    process.exit(2);
  }
  if (err instanceof TabstackError) {
    console.error(`Error (${err.status}): ${err.message}`);
  } else {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
});
