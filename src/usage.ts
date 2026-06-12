/**
 * usage.ts — local usage ledger, dashboard calibration, and cost estimator.
 *
 * The API exposes no balance and no per-call token cost (verified against the
 * spec and live probes — only the console dashboard shows "tokens remaining").
 * So we observe locally: every API call is appended to a ledger, and the
 * dashboard balance is fed in as calibration points — pasted by hand
 * (`usage set`) or scraped with the user's console session cookie
 * (`usage sync`). The delta between two calibrations, distributed over the
 * calls logged in between, teaches per-verb costs; those averages price the
 * next call before it runs.
 */

import { join } from "path";
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
} from "fs";
import { CONFIG_DIR } from "./config";

export interface LedgerEntry {
  ts: number;
  verb: string; // extract | generate | research | automate | input
  ms: number;
  rlRemaining?: number;
  rlLimit?: number;
}

export interface Calibration {
  ts: number;
  tokens: number;
  source: "manual" | "sync";
}

export interface UsageState {
  calibrations: Calibration[];
  /** Learned average tokens per call, by verb. */
  learned: Record<string, { avg: number; samples: number }>;
  consoleCookie?: string;
}

const ledgerPath = () => join(CONFIG_DIR, "usage.jsonl");
const statePath = () => join(CONFIG_DIR, "usage.json");

/** Relative cost priors, used to split a consumed delta before we have data. */
const DEFAULT_WEIGHTS: Record<string, number> = {
  extract: 1,
  generate: 3,
  research: 25,
  automate: 40,
  input: 0,
};

export function verbFromPath(path: string): string {
  if (path.includes("/extract/")) return "extract";
  if (path.includes("/generate/")) return "generate";
  if (path.includes("/research")) return "research";
  if (path.includes("/input")) return "input";
  if (path.includes("/automate")) return "automate";
  return "other";
}

/** Append one call to the ledger. Never throws — accounting must not break calls. */
export function recordCall(entry: LedgerEntry): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    appendFileSync(ledgerPath(), JSON.stringify(entry) + "\n");
  } catch {
    /* best effort */
  }
}

export function readLedger(): LedgerEntry[] {
  try {
    return readFileSync(ledgerPath(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LedgerEntry);
  } catch {
    return [];
  }
}

export function readState(): UsageState {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as UsageState;
  } catch {
    return { calibrations: [], learned: {} };
  }
}

/** Persist state with owner-only permissions — it can hold a session cookie. */
export function writeState(state: UsageState): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(statePath(), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(statePath(), 0o600);
  } catch {
    /* best effort */
  }
}

/** Weight for a verb: learned average when we have one, prior otherwise. */
function weight(state: UsageState, verb: string): number {
  return state.learned[verb]?.avg ?? DEFAULT_WEIGHTS[verb] ?? 1;
}

/**
 * Record a new balance reading. If an earlier calibration exists and tokens
 * decreased, distribute the consumed delta across the calls logged in the
 * window (proportionally to current weights) and fold the result into the
 * learned per-verb averages.
 */
export function addCalibration(
  tokens: number,
  source: Calibration["source"],
): { consumed?: number; callsInWindow: number } {
  const state = readState();
  const prev = state.calibrations.at(-1);
  const now = Date.now();
  let consumed: number | undefined;
  let callsInWindow = 0;

  if (prev && tokens < prev.tokens) {
    consumed = prev.tokens - tokens;
    const calls = readLedger().filter((e) => e.ts > prev.ts && e.ts <= now);
    callsInWindow = calls.length;
    if (callsInWindow > 0) {
      const counts: Record<string, number> = {};
      for (const c of calls) counts[c.verb] = (counts[c.verb] ?? 0) + 1;
      const totalWeight = Object.entries(counts).reduce(
        (sum, [verb, n]) => sum + weight(state, verb) * n,
        0,
      );
      if (totalWeight > 0) {
        for (const [verb, n] of Object.entries(counts)) {
          const perCall = (consumed * weight(state, verb)) / totalWeight;
          const old = state.learned[verb];
          // Blend by sample count so later windows refine, not overwrite.
          const samples = (old?.samples ?? 0) + n;
          const avg = old ? (old.avg * old.samples + perCall * n) / samples : perCall;
          state.learned[verb] = { avg: Math.round(avg * 10) / 10, samples };
        }
      }
    }
  }

  state.calibrations.push({ ts: now, tokens, source });
  writeState(state);
  return { consumed, callsInWindow };
}

/** Estimated tokens remaining now: last balance minus priced calls since. */
export function estimateRemaining(state: UsageState): number | undefined {
  const last = state.calibrations.at(-1);
  if (!last) return undefined;
  const since = readLedger().filter((e) => e.ts > last.ts);
  const spent = since.reduce((sum, e) => sum + weight(state, e.verb), 0);
  return Math.max(0, Math.round(last.tokens - spent));
}

// ---------------------------------------------------------------------------
// Console sync — scrape "tokens remaining" from the dashboard with the user's
// session cookie. Scaffolding until Tabstack exposes GET /v1/usage.
// ---------------------------------------------------------------------------

const CONSOLE_BASE = () =>
  (process.env.TABSTACK_CONSOLE_URL || "https://console.tabstack.ai").replace(/\/+$/, "");

/**
 * Pull the balance out of dashboard HTML. The console phrases it as credits
 * ("5,750 CREDITS AVAILABLE", "<strong>5,750</strong> credits remaining");
 * we also accept "tokens" in case the wording shifts. Exported for tests.
 */
export function parseTokensFromHtml(html: string): number | undefined {
  // Markup sits between the number and its label — flatten tags to spaces.
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const patterns = [
    /([\d][\d,.]*)\s*([kKmM])?\s*credits?\s*(?:available|remaining|left)/i,
    /credits?\s*(?:available|remaining|left)[^0-9]{0,40}?([\d][\d,.]*)\s*([kKmM])?/i,
    /([\d][\d,.]*)\s*([kKmM])?\s*tokens?\s*(?:available|remaining|left)/i,
    /tokens?\s*(?:available|remaining|left)[^0-9]{0,40}?([\d][\d,.]*)\s*([kKmM])?/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      let n = Number(m[1].replace(/,/g, ""));
      const suffix = (m[2] ?? "").toLowerCase();
      if (suffix === "k") n *= 1_000;
      if (suffix === "m") n *= 1_000_000;
      if (Number.isFinite(n)) return Math.round(n);
    }
  }
  return undefined;
}

export async function syncFromConsole(
  cookie: string,
): Promise<{ tokens: number; page: string }> {
  const pages = ["/dashboard", "/", "/usage", "/billing"];
  let sawLogin = false;
  for (const page of pages) {
    const res = await fetch(CONSOLE_BASE() + page, {
      headers: { Cookie: cookie, Accept: "text/html" },
      redirect: "follow",
    });
    if (!res.ok) continue;
    const html = await res.text();
    if (/sessions\/new|sign[ -]?in|email_address/i.test(html) && !/tokens?/i.test(html)) {
      sawLogin = true;
      continue;
    }
    const tokens = parseTokensFromHtml(html);
    if (tokens !== undefined) return { tokens, page };
  }
  throw new Error(
    sawLogin
      ? "console session rejected — the cookie has expired; copy a fresh one from your browser and run 'tabstack usage cookie'"
      : "could not find a credit balance on any console page — run 'tabstack usage set <credits>' manually and please open an issue",
  );
}
