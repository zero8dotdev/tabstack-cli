/**
 * client.ts — thin Tabstack API client over fetch.
 *
 * Two transports:
 *   - postJson:   request/response JSON endpoints (extract, generate)
 *   - postStream: Server-Sent Events endpoints (research, automate)
 *
 * Errors from the API ({ "error": "..." }) are normalized into TabstackError
 * with the HTTP status attached, so the CLI can print one clean line to stderr.
 */

import { getBaseUrl } from "./config";
import { recordCall, verbFromPath } from "./usage";
import { progress } from "./format";

/** Optional timeout (seconds) for non-streaming calls, set by --timeout. */
let requestTimeoutSecs: number | undefined;

export function setRequestTimeout(seconds: number): void {
  requestTimeoutSecs = seconds;
}

const MAX_RATELIMIT_RETRIES = 2;

/**
 * Fetch with 429 handling: wait until x-ratelimit-reset (capped at 90s) and
 * retry, so pipelines absorb rate limits instead of failing on them.
 * On success, log the call to the local usage ledger.
 */
async function fetchWithRetry(path: string, init: RequestInit): Promise<Response> {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${getBaseUrl()}${path}`, init);
    if (res.status === 429 && attempt < MAX_RATELIMIT_RETRIES) {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const waitMs = Number.isFinite(reset)
        ? Math.min(Math.max(reset * 1000 - Date.now(), 1_000), 90_000)
        : 2 ** attempt * 2_000;
      progress(`· rate limited — retrying in ${Math.ceil(waitMs / 1000)}s`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (res.ok) {
      recordCall({
        ts: Date.now(),
        verb: verbFromPath(path),
        ms: Date.now() - started,
        rlRemaining: Number(res.headers.get("x-ratelimit-remaining")) || undefined,
        rlLimit: Number(res.headers.get("x-ratelimit-limit")) || undefined,
      });
    }
    return res;
  }
}

export class TabstackError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TabstackError";
    this.status = status;
  }
}

async function raise(res: Response): Promise<never> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body && typeof body.error === "string") message = body.error;
  } catch {
    // non-JSON error body — keep the status line
  }
  throw new TabstackError(res.status, message);
}

function headers(apiKey: string, accept?: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (accept) h.Accept = accept;
  return h;
}

/** POST a JSON body and return the parsed JSON response. */
export async function postJson<T = unknown>(
  path: string,
  body: unknown,
  apiKey: string,
): Promise<T> {
  let res: Response;
  try {
    res = await fetchWithRetry(path, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(body),
      signal: requestTimeoutSecs ? AbortSignal.timeout(requestTimeoutSecs * 1000) : undefined,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new TabstackError(0, `request timed out after ${requestTimeoutSecs}s`);
    }
    throw err;
  }
  if (!res.ok) await raise(res);
  return (await res.json()) as T;
}

export interface SseEvent {
  /** Event name, e.g. "start", "iteration:start", "task:completed". */
  event: string;
  /** Parsed JSON payload (or the raw string if it wasn't JSON). */
  data: any;
}

/**
 * POST a JSON body and stream back Server-Sent Events.
 *
 * Tabstack streams agentic endpoints as SSE. Some events carry the event name
 * in the SSE `event:` field; others wrap `{ event, data }` inside the JSON
 * `data:` payload. We normalize both into a flat { event, data } so callers
 * switch on a single shape.
 */
export async function* postStream(
  path: string,
  body: unknown,
  apiKey: string,
): AsyncGenerator<SseEvent> {
  const res = await fetchWithRetry(path, {
    method: "POST",
    headers: headers(apiKey, "text/event-stream"),
    body: JSON.stringify(body),
  });
  if (!res.ok) await raise(res);
  if (!res.body) throw new TabstackError(0, "API returned no response body to stream");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let heldCR = false; // a trailing \r may be half of a \r\n split across chunks

  // SSE allows \r\n, \n, or \r line endings — normalize everything to \n.
  const toLF = (chunk: string): string => {
    let text = (heldCR ? "\r" : "") + chunk;
    heldCR = text.endsWith("\r");
    if (heldCR) text = text.slice(0, -1);
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  };

  function* drainFrames(): Generator<SseEvent> {
    // SSE frames are separated by a blank line.
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const evt = parseFrame(frame);
      if (evt) yield normalize(evt);
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += toLF(decoder.decode(value, { stream: true }));
    yield* drainFrames();
  }

  // Stream ended: flush the decoder and any held \r, then emit whatever
  // remains — servers may omit the blank line after the final frame.
  buffer += toLF(decoder.decode());
  if (heldCR) buffer += "\n";
  yield* drainFrames();
  if (buffer.trim()) {
    const evt = parseFrame(buffer);
    if (evt) yield normalize(evt);
  }
}

function parseFrame(frame: string): SseEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // comment / heartbeat
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (data.length === 0) return null;
  const raw = data.join("\n");
  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    return { event, data: raw };
  }
}

/** Collapse the two SSE shapes into one flat { event, data }. */
function normalize(evt: SseEvent): SseEvent {
  const d = evt.data;
  if (d && typeof d === "object" && typeof d.event === "string" && "data" in d) {
    return { event: d.event, data: d.data };
  }
  if (d && typeof d === "object" && typeof d.event === "string") {
    return { event: d.event, data: d };
  }
  return evt;
}
