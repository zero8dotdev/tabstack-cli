/**
 * config.ts — environment, base URL, defaults, and credential storage.
 *
 * Mirrors the Smriti pattern: a single place for env vars and paths so no
 * other file reads process.env or the filesystem for config directly.
 */

import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, chmodSync } from "fs";

/** API base URL: --base-url flag > TABSTACK_BASE_URL env > default. */
let baseUrl = (process.env.TABSTACK_BASE_URL || "https://api.tabstack.ai").replace(/\/+$/, "");

export function getBaseUrl(): string {
  return baseUrl;
}

/** Apply a --base-url override (called once from the CLI entry point). */
export function setBaseUrl(url: string): void {
  baseUrl = url.replace(/\/+$/, "");
}

/** Where `tabstack login` stores the key. Honors XDG; override for tests. */
export const CONFIG_DIR =
  process.env.TABSTACK_CONFIG_DIR ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tabstack");

export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

/** The Tabstack web console — where users create API keys. */
export const CONSOLE_URL = "https://console.tabstack.ai/";

/** Endpoint paths, kept in one place. */
export const ENDPOINTS = {
  extractMarkdown: "/v1/extract/markdown",
  extractJson: "/v1/extract/json",
  generateJson: "/v1/generate/json",
  research: "/v1/research",
  automate: "/v1/automate",
  automateInput: (requestId: string) => `/v1/automate/${encodeURIComponent(requestId)}/input`,
} as const;

/**
 * Resolve the API key from (in order):
 *   1. an explicit --api-key override
 *   2. the TABSTACK_API_KEY environment variable
 *   3. the stored credential from `tabstack login`
 *
 * Throws a clear, actionable error if none are present.
 */
export function getApiKey(override?: string): string {
  const resolved = resolveKey(override);
  if (!resolved) {
    throw new Error(
      "Not authenticated. Run 'tabstack login', set TABSTACK_API_KEY, or pass --api-key <key>.\n" +
        "Create a key at " + CONSOLE_URL + " (API Keys → Create New API Key).",
    );
  }
  return resolved.key;
}

export type KeySource = "--api-key flag" | "TABSTACK_API_KEY env" | "config file";

/**
 * Resolve the key together with where it came from, for `tabstack status`.
 * Never returns or prints the key value to the user — only its source.
 */
export function resolveKey(override?: string): { key: string; source: KeySource } | undefined {
  if (override) return { key: override, source: "--api-key flag" };
  if (process.env.TABSTACK_API_KEY)
    return { key: process.env.TABSTACK_API_KEY, source: "TABSTACK_API_KEY env" };
  const stored = readStoredKey();
  if (stored) return { key: stored, source: "config file" };
  return undefined;
}

/** Read the stored API key, or undefined if not logged in / unreadable. */
export function readStoredKey(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as { apiKey?: unknown };
    return typeof parsed.apiKey === "string" && parsed.apiKey ? parsed.apiKey : undefined;
  } catch {
    return undefined;
  }
}

/** Persist the API key to the config file with owner-only (0600) permissions. */
export function saveKey(apiKey: string): string {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify({ apiKey }, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(CONFIG_FILE, 0o600); // ensure perms even if the file pre-existed
  } catch {
    /* best effort */
  }
  return CONFIG_FILE;
}

/** Remove the stored credential. Returns true if a file was deleted. */
export function clearKey(): boolean {
  if (!existsSync(CONFIG_FILE)) return false;
  rmSync(CONFIG_FILE);
  return true;
}
