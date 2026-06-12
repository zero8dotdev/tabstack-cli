/**
 * format.ts — output modes, color, and argument helpers.
 *
 * Convention (matches Smriti): data goes to stdout, progress/errors go to
 * stderr. The output MODE matches the official Tabstack CLI: pretty
 * (human-readable) on a TTY, JSON when piped, forceable with -o/--output.
 * Streaming commands emit one NDJSON line per event in JSON mode.
 */

export type OutputMode = "pretty" | "json";

/** A bad-invocation error: the CLI prints it with usage context and exits 2. */
export class UsageError extends Error {}

/**
 * Decide the output mode. An explicit -o/--output (or the --json shorthand)
 * wins; otherwise default to pretty on a terminal and json when piped, so
 * `tabstack ... | jq .` just works.
 */
export function resolveMode(explicit: string | undefined, jsonFlag: boolean): OutputMode {
  if (explicit) {
    if (explicit !== "pretty" && explicit !== "json") {
      throw new UsageError(`--output must be "pretty" or "json" (got "${explicit}")`);
    }
    return explicit;
  }
  if (jsonFlag) return "json";
  return process.stdout.isTTY ? "pretty" : "json";
}

/** Pretty-print a value as JSON for json-mode output. */
export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** One compact NDJSON line per stream event in json mode. */
export function ndjson(event: string, data: unknown): string {
  return JSON.stringify({ event, data });
}

// ---------------------------------------------------------------------------
// Color — only when stderr is a TTY, and disabled by --no-color or the
// NO_COLOR convention (https://no-color.org).
// ---------------------------------------------------------------------------

// Gated per stream: dim() goes to stderr, green()/red() go to stdout — each
// colors only when its own stream is a TTY, so ANSI never leaks into a pipe.
let colorErr = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
let colorOut = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

/** Turn color off (for --no-color). It can never be forced on. */
export function disableColor(): void {
  colorErr = false;
  colorOut = false;
}

function paint(enabled: boolean, code: string, text: string): string {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const dim = (t: string) => paint(colorErr, "2", t);
export const dimOut = (t: string) => paint(colorOut, "2", t);
export const green = (t: string) => paint(colorOut, "32", t);
export const red = (t: string) => paint(colorOut, "31", t);

/** Write a progress/status line to stderr so stdout stays pipeable. */
export function progress(line: string): void {
  process.stderr.write(dim(line) + "\n");
}

/**
 * Resolve a "schema-ish" argument into a parsed JSON object.
 * Accepts:
 *   - "-"           → read from stdin
 *   - "@path.json"  → read from a file
 *   - inline JSON   → parse directly
 */
export async function resolveJsonArg(value: string, label = "value"): Promise<unknown> {
  const text = await resolveTextArg(value);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON for ${label}: ${(err as Error).message}`);
  }
}

/**
 * Resolve a "text-ish" argument into a string.
 * Accepts "-" (stdin), "@path" (file), or the literal string.
 */
export async function resolveTextArg(value: string): Promise<string> {
  if (value === "-") return readStdin();
  if (value.startsWith("@")) {
    const path = value.slice(1);
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`File not found: ${path}`);
    return file.text();
  }
  return value;
}

async function readStdin(): Promise<string> {
  return Bun.stdin.text();
}
