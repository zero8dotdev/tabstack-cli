/**
 * auth.ts — `tabstack login` / `logout`.
 *
 * Tabstack authenticates with a bearer API key created in the web console;
 * there is no headless OAuth/device-code flow. So `login` follows the standard
 * CLI pattern: open the console in the browser, let the user create/copy a key,
 * read it back, optionally verify it with a cheap call, and store it 0600.
 */

import { CONSOLE_URL, ENDPOINTS, saveKey, clearKey, readStoredKey, CONFIG_FILE } from "./config";
import { postJson, TabstackError } from "./client";
import { progress } from "./format";

export interface LoginOptions {
  withKey?: string; // skip the prompt, use this key
  openBrowser?: boolean; // default true
  verify?: boolean; // default true
}

export async function login(opts: LoginOptions): Promise<void> {
  if (readStoredKey()) progress("You're already logged in — this will replace the stored key.");

  let key = opts.withKey?.trim();

  // No key passed: open the console and read one from the user (or a pipe).
  if (!key) {
    if (opts.openBrowser !== false && process.stdin.isTTY) {
      progress(`Opening ${CONSOLE_URL} — sign in, then API Keys → Create New API Key.`);
      openBrowser(CONSOLE_URL);
    } else {
      progress(`Create a key at ${CONSOLE_URL} (API Keys → Create New API Key).`);
    }
    key = (await readKey(process.stdin.isTTY)).trim();
  }

  if (!key) throw new Error("No API key provided.");

  if (opts.verify !== false) {
    progress("Verifying key…");
    await verifyKey(key);
    progress("Key is valid.");
  }

  const path = saveKey(key);
  progress(`Saved to ${path}. You're logged in.`);
}

export function logout(): void {
  const removed = clearKey();
  progress(removed ? `Logged out. Removed ${CONFIG_FILE}.` : "Not logged in — nothing to remove.");
}

/** Make a minimal authenticated call to confirm the key works. */
async function verifyKey(apiKey: string): Promise<void> {
  try {
    await postJson(ENDPOINTS.extractMarkdown, { url: "https://example.com" }, apiKey);
  } catch (err) {
    if (err instanceof TabstackError && (err.status === 401 || err.status === 403)) {
      throw new Error("That key was rejected (401/403). Double-check you copied it correctly.");
    }
    throw err; // network/other: surface as-is
  }
}

/** Open a URL in the default browser. Best-effort, never throws. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* headless or no opener — the URL was already printed to stderr */
  }
}

/** Read a single line (the API key) from stdin. Prompt goes to stderr. */
async function readKey(interactive: boolean): Promise<string> {
  if (interactive) process.stderr.write("Paste your API key: ");
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      const nl = buf.indexOf("\n");
      if (nl >= 0) return buf.slice(0, nl);
      if (done) return buf;
    }
  } finally {
    reader.releaseLock();
  }
}
