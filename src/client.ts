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

/** Optional timeout (seconds) for non-streaming calls, set by --timeout. */
let requestTimeoutSecs: number | undefined;

export function setRequestTimeout(seconds: number): void {
  requestTimeoutSecs = seconds;
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
    res = await fetch(`${getBaseUrl()}${path}`, {
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
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: "POST",
    headers: headers(apiKey, "text/event-stream"),
    body: JSON.stringify(body),
  });
  if (!res.ok) await raise(res);
  if (!res.body) throw new TabstackError(0, "API returned no response body to stream");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const evt = parseFrame(frame);
      if (evt) yield normalize(evt);
    }
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
