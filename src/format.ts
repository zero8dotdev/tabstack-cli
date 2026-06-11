/**
 * format.ts — output helpers.
 *
 * Convention (matches Smriti): data goes to stdout, progress/errors go to
 * stderr, and `--json` always prints machine-readable JSON via json().
 */

/** Pretty-print a value as JSON for --json output. */
export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Whether stdout is a TTY (used to decide on human vs. plain output). */
export function isTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

/** Write a progress/status line to stderr so stdout stays pipeable. */
export function progress(line: string): void {
  process.stderr.write(line + "\n");
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
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
}
