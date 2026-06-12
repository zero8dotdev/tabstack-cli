/**
 * cli.test.ts — end-to-end tests against a local mock of the Tabstack API.
 *
 * We point the CLI at a Bun.serve() mock via TABSTACK_BASE_URL and run the
 * real binary with Bun.spawn, asserting on stdout/stderr/exit code. This
 * exercises the router, arg parsing, JSON client, the SSE parser, and the
 * login/logout credential storage. An isolated temp TABSTACK_CONFIG_DIR keeps
 * the tests from touching the developer's real ~/.config/tabstack.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ENTRY = new URL("../src/index.ts", import.meta.url).pathname;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let configDir: string;
let flaky429Seen = false;

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "tabstack-test-"));
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.json().catch(() => ({}));

      // Auth check: any request with the "bad-key" bearer is rejected 401.
      const auth = req.headers.get("authorization") || "";
      if (auth.includes("bad-key")) {
        return Response.json({ error: "Unauthorized - Invalid token" }, { status: 401 });
      }

      if (url.pathname === "/v1/extract/markdown") {
        if ((body as any).url?.includes("slow")) await new Promise((r) => setTimeout(r, 500));
        // First call for a "flaky429" URL is rate limited; the retry succeeds.
        if ((body as any).url?.includes("flaky429") && !flaky429Seen) {
          flaky429Seen = true;
          return Response.json({ error: "rate limited" }, {
            status: 429,
            headers: { "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 1) },
          });
        }
        return Response.json({
          url: (body as any).url,
          content: "# Hello\n\nworld",
          ...((body as any).metadata ? { metadata: { title: "Hello Page" } } : {}),
        });
      }
      // Fake console dashboard for `usage sync` (cookie-gated).
      if (url.pathname === "/usage") {
        if (!(req.headers.get("cookie") || "").includes("good-session")) {
          return new Response("<form action='/sessions/new'><input name='email_address'></form>", { headers: { "Content-Type": "text/html" } });
        }
        return new Response("<html><div class='balance'>12,345 tokens remaining</div></html>", { headers: { "Content-Type": "text/html" } });
      }
      if (url.pathname === "/v1/extract/json") {
        return Response.json({ title: "Example" });
      }
      if (url.pathname === "/v1/generate/json") {
        return Response.json({ summary: "A short summary." });
      }
      if (url.pathname === "/v1/research") {
        const q = (body as any).query ?? "";
        // Rude variants: CRLF line endings, and no blank line after the
        // final frame — both legal SSE that the parser must survive.
        if (q.includes("crlf")) {
          const sse = `event: start\r\ndata: {"message":"go"}\r\n\r\nevent: complete\r\ndata: ${JSON.stringify({ report: "# CRLF Report" })}\r\n\r\n`;
          return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
        }
        if (q.includes("unterminated")) {
          const sse = `event: start\ndata: {"message":"go"}\n\nevent: complete\ndata: ${JSON.stringify({ report: "# Last Frame Report" })}\n`;
          return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
        }
        const sse = [
          `event: start\ndata: ${JSON.stringify({ message: "go" })}\n\n`,
          `event: complete\ndata: ${JSON.stringify({ report: "# Report\nbody", metadata: { citedPages: [{ title: "Src", url: "https://e.com" }] } })}\n\n`,
        ].join("");
        return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
      }
      if (url.pathname === "/v1/automate") {
        // A task containing "fail" ends with success:false to exercise exit code 3.
        const failed = (body as any).task?.includes("fail");
        // Like the real API: only pause for input when the body opts in.
        const pause = (body as any).interactive === true
          ? `data: ${JSON.stringify({ event: "interactive:form_data:request", data: { requestId: "req-42" } })}\n\n`
          : "";
        // Echo the geo country back so tests can assert the exact wire field.
        const geoCountry = (body as any).geo_target?.country;
        // Wrapped shape: { event, data } inside the SSE data payload.
        const sse =
          `data: ${JSON.stringify({ event: "agent:status", data: { message: "working" } })}\n\n` +
          pause +
          `data: ${JSON.stringify({ event: "task:completed", data: { finalAnswer: geoCountry ? `geo:${geoCountry}` : failed ? "could not" : "done", success: !failed } })}\n\n`;
        return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
      }
      const inputMatch = url.pathname.match(/^\/v1\/automate\/([^/]+)\/input$/);
      if (inputMatch) {
        const b = body as any;
        if (!Array.isArray(b.fields) && b.cancelled !== true) {
          return Response.json({ error: "fields or cancelled required" }, { status: 400 });
        }
        return Response.json({ requestId: inputMatch[1], status: "accepted" });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  rmSync(configDir, { recursive: true, force: true });
});

async function run(args: string[], opts: { env?: Record<string, string>; stdin?: string } = {}) {
  const proc = Bun.spawn(["bun", "run", ENTRY, ...args], {
    env: {
      ...process.env,
      TABSTACK_BASE_URL: base,
      TABSTACK_API_KEY: "test-key",
      TABSTACK_CONFIG_DIR: configDir,
      ...opts.env,
    },
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { stdout, stderr, code };
}

test("extract markdown piped (no flags) emits the JSON envelope", async () => {
  // Tests run with stdout piped, so the default output mode is json.
  const { stdout, code } = await run(["extract", "markdown", "https://example.com"]);
  expect(code).toBe(0);
  expect(JSON.parse(stdout).content).toContain("# Hello");
});

test("extract markdown -o pretty prints raw markdown", async () => {
  const { stdout, code } = await run(["extract", "markdown", "https://example.com", "-o", "pretty"]);
  expect(code).toBe(0);
  expect(stdout).toContain("# Hello");
  expect(stdout.trim().startsWith("{")).toBe(false);
});

test("extract markdown --metadata requests and returns page metadata", async () => {
  const { stdout, code } = await run(["extract", "markdown", "https://example.com", "--metadata"]);
  expect(code).toBe(0);
  expect(JSON.parse(stdout).metadata).toEqual({ title: "Hello Page" });
});

test("extract json prints structured JSON", async () => {
  const { stdout, code } = await run(["extract", "json", "https://example.com", "--schema", '{"type":"object"}']);
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ title: "Example" });
});

test("generate json sends instructions and prints result", async () => {
  const { stdout, code } = await run([
    "generate", "json", "https://example.com",
    "--schema", '{"type":"object"}',
    "--instructions", "summarize",
  ]);
  expect(code).toBe(0);
  expect(JSON.parse(stdout).summary).toBe("A short summary.");
});

test("research -o pretty streams and prints the report to stdout", async () => {
  const { stdout, stderr, code } = await run(["research", "anything", "-o", "pretty"]);
  expect(code).toBe(0);
  expect(stdout).toContain("# Report");
  expect(stderr).toContain("Cited 1 source"); // citations go to stderr
});

test("research survives CRLF line endings in the SSE stream", async () => {
  const { stdout, code } = await run(["research", "crlf endings", "-o", "pretty"]);
  expect(code).toBe(0);
  expect(stdout).toContain("# CRLF Report");
});

test("research does not drop a final frame missing its trailing blank line", async () => {
  const { stdout, code } = await run(["research", "unterminated stream", "-o", "pretty"]);
  expect(code).toBe(0);
  expect(stdout).toContain("# Last Frame Report");
});

test("research piped emits NDJSON, one event per line", async () => {
  const { stdout, code } = await run(["research", "anything"]);
  expect(code).toBe(0);
  const lines = stdout.trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => l.event)).toEqual(["start", "complete"]);
  expect(lines[1].data.report).toContain("# Report");
});

test("automate -o pretty handles wrapped SSE events and prints finalAnswer", async () => {
  const { stdout, code } = await run(["automate", "do a thing", "--url", "https://example.com", "-o", "pretty"]);
  expect(code).toBe(0);
  expect(stdout.trim()).toBe("done");
});

test("automate --interactive opts in and surfaces the input request id", async () => {
  const { stderr, code } = await run(["automate", "do a thing", "--interactive", "-o", "pretty"]);
  expect(code).toBe(0);
  expect(stderr).toContain("tabstack input req-42");
});

test("automate without --interactive never receives an input request", async () => {
  const { stderr, code } = await run(["automate", "do a thing", "-o", "pretty"]);
  expect(code).toBe(0);
  expect(stderr).not.toContain("input requested");
});

test("automate --geo sends geo_target (snake_case) on the wire", async () => {
  const { stdout, code } = await run(["automate", "do a thing", "--geo", "GB", "-o", "pretty"]);
  expect(code).toBe(0);
  expect(stdout.trim()).toBe("geo:GB"); // mock echoes body.geo_target.country
});

test("automate that reports failure exits 3", async () => {
  const { stderr, code } = await run(["automate", "fail at a thing", "-o", "pretty"]);
  expect(code).toBe(3);
  expect(stderr).toContain("automation reported failure");
});

test("missing --schema prints Usage and exits 2, not an auth error", async () => {
  const { stderr, code } = await run(["extract", "json", "https://example.com"], { env: { TABSTACK_API_KEY: "" } });
  expect(code).toBe(2);
  expect(stderr).toContain("Usage:");
  expect(stderr).not.toContain("Not authenticated");
});

test("no credentials gives a clean 'Not authenticated' error", async () => {
  const { stderr, code } = await run(["extract", "markdown", "https://example.com"], {
    env: { TABSTACK_API_KEY: "", TABSTACK_CONFIG_DIR: join(configDir, "empty") },
  });
  expect(code).toBe(1);
  expect(stderr).toContain("Not authenticated");
});

test("unknown command exits non-zero", async () => {
  const { stderr, code } = await run(["frobnicate"]);
  expect(code).toBe(1);
  expect(stderr).toContain("Unknown command");
});

// --- Auth flow ----------------------------------------------------------------

test("login --with-key verifies and stores the key", async () => {
  const loginDir = join(configDir, "login1");
  const { stderr, code } = await run(["login", "--with-key", "good-key"], {
    env: { TABSTACK_API_KEY: "", TABSTACK_CONFIG_DIR: loginDir },
  });
  expect(code).toBe(0);
  expect(stderr).toContain("logged in");
  const stored = JSON.parse(readFileSync(join(loginDir, "config.json"), "utf8"));
  expect(stored.apiKey).toBe("good-key");
});

test("a stored key is used when env/flag are absent", async () => {
  const loginDir = join(configDir, "login2");
  await run(["login", "--with-key", "good-key", "--no-verify"], {
    env: { TABSTACK_API_KEY: "", TABSTACK_CONFIG_DIR: loginDir },
  });
  const { stdout, code } = await run(["extract", "markdown", "https://example.com"], {
    env: { TABSTACK_API_KEY: "", TABSTACK_CONFIG_DIR: loginDir },
  });
  expect(code).toBe(0);
  expect(stdout).toContain("# Hello");
});

test("login rejects a bad key during verification", async () => {
  const loginDir = join(configDir, "login3");
  const { stderr, code } = await run(["login", "--with-key", "bad-key"], {
    env: { TABSTACK_API_KEY: "", TABSTACK_CONFIG_DIR: loginDir },
  });
  expect(code).toBe(1);
  expect(stderr).toContain("rejected");
  expect(existsSync(join(loginDir, "config.json"))).toBe(false);
});

test("login reads the key from stdin when piped", async () => {
  const loginDir = join(configDir, "login4");
  const { code } = await run(["login", "--no-verify"], {
    env: { TABSTACK_API_KEY: "", TABSTACK_CONFIG_DIR: loginDir },
    stdin: "piped-key\n",
  });
  expect(code).toBe(0);
  expect(JSON.parse(readFileSync(join(loginDir, "config.json"), "utf8")).apiKey).toBe("piped-key");
});

test("logout removes the stored key", async () => {
  const loginDir = join(configDir, "login5");
  await run(["login", "--with-key", "good-key", "--no-verify"], {
    env: { TABSTACK_API_KEY: "", TABSTACK_CONFIG_DIR: loginDir },
  });
  const { stderr, code } = await run(["logout"], {
    env: { TABSTACK_API_KEY: "", TABSTACK_CONFIG_DIR: loginDir },
  });
  expect(code).toBe(0);
  expect(stderr).toContain("Logged out");
  expect(existsSync(join(loginDir, "config.json"))).toBe(false);
});

test("complete flow: no auth → login → stored key works → logout → access revoked", async () => {
  const loginDir = join(configDir, "flow");
  const env = { TABSTACK_API_KEY: "", TABSTACK_CONFIG_DIR: loginDir };

  // Before login: authenticated commands fail with an actionable error.
  const before = await run(["extract", "markdown", "https://example.com"], { env });
  expect(before.code).toBe(1);
  expect(before.stderr).toContain("Not authenticated");

  // Login verifies the key against the API and stores it.
  const login = await run(["login", "--with-key", "good-key"], { env });
  expect(login.code).toBe(0);
  expect(login.stderr).toContain("logged in");

  // The stored key alone authenticates subsequent commands.
  const during = await run(["extract", "markdown", "https://example.com"], { env });
  expect(during.code).toBe(0);
  expect(during.stdout).toContain("# Hello");

  // Logout deletes the credential...
  const logout = await run(["logout"], { env });
  expect(logout.code).toBe(0);
  expect(existsSync(join(loginDir, "config.json"))).toBe(false);

  // ...and access is actually revoked.
  const after = await run(["extract", "markdown", "https://example.com"], { env });
  expect(after.code).toBe(1);
  expect(after.stderr).toContain("Not authenticated");
});

test("stored credential file has owner-only (0600) permissions", async () => {
  const loginDir = join(configDir, "perms");
  await run(["login", "--with-key", "good-key", "--no-verify"], {
    env: { TABSTACK_API_KEY: "", TABSTACK_CONFIG_DIR: loginDir },
  });
  const mode = statSync(join(loginDir, "config.json")).mode & 0o777;
  expect(mode).toBe(0o600);
});

test("failed login leaves the previously stored key untouched", async () => {
  const loginDir = join(configDir, "keep-old");
  const env = { TABSTACK_API_KEY: "", TABSTACK_CONFIG_DIR: loginDir };
  await run(["login", "--with-key", "good-key", "--no-verify"], { env });
  const { code } = await run(["login", "--with-key", "bad-key"], { env });
  expect(code).toBe(1);
  expect(JSON.parse(readFileSync(join(loginDir, "config.json"), "utf8")).apiKey).toBe("good-key");
});

test("re-login warns that the stored key will be replaced, and replaces it", async () => {
  const loginDir = join(configDir, "relogin");
  const env = { TABSTACK_API_KEY: "", TABSTACK_CONFIG_DIR: loginDir };
  await run(["login", "--with-key", "good-key", "--no-verify"], { env });
  const { stderr, code } = await run(["login", "--with-key", "newer-key", "--no-verify"], { env });
  expect(code).toBe(0);
  expect(stderr).toContain("already logged in");
  expect(JSON.parse(readFileSync(join(loginDir, "config.json"), "utf8")).apiKey).toBe("newer-key");
});

test("TABSTACK_API_KEY env var takes precedence over the stored key", async () => {
  const loginDir = join(configDir, "env-precedence");
  // Store a key the mock rejects; success then proves the env key was used.
  await run(["login", "--with-key", "bad-key", "--no-verify"], {
    env: { TABSTACK_API_KEY: "", TABSTACK_CONFIG_DIR: loginDir },
  });
  const stored = await run(["extract", "markdown", "https://example.com"], {
    env: { TABSTACK_API_KEY: "", TABSTACK_CONFIG_DIR: loginDir },
  });
  expect(stored.code).toBe(1); // sanity: the stored key alone is rejected
  const { code } = await run(["extract", "markdown", "https://example.com"], {
    env: { TABSTACK_API_KEY: "good-key", TABSTACK_CONFIG_DIR: loginDir },
  });
  expect(code).toBe(0);
});

test("--api-key flag takes precedence over the env var", async () => {
  const { code } = await run(
    ["extract", "markdown", "https://example.com", "--api-key", "good-key"],
    { env: { TABSTACK_API_KEY: "bad-key" } },
  );
  expect(code).toBe(0);
});

test("logout when not logged in is a no-op with exit 0", async () => {
  const { stderr, code } = await run(["logout"], {
    env: { TABSTACK_API_KEY: "", TABSTACK_CONFIG_DIR: join(configDir, "never-logged-in") },
  });
  expect(code).toBe(0);
  expect(stderr).toContain("nothing to remove");
});

// --- input (human-in-the-loop) --------------------------------------------------

test("input submits field values to /v1/automate/{id}/input", async () => {
  const { stdout, code } = await run([
    "input", "req-123",
    "--data", '{"fields":[{"ref":"field1","value":"yes"}]}',
  ]);
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ submitted: true });
});

test("input can decline with cancelled:true", async () => {
  const { code } = await run(["input", "req-123", "--data", '{"cancelled":true}']);
  expect(code).toBe(0);
});

test("input without --data is a usage error (exit 2)", async () => {
  const { stderr, code } = await run(["input", "req-123"]);
  expect(code).toBe(2);
  expect(stderr).toContain("Usage:");
});

test("input with neither fields nor cancelled is a usage error (exit 2)", async () => {
  const { stderr, code } = await run(["input", "req-123", "--data", '{"bogus":1}']);
  expect(code).toBe(2);
  expect(stderr).toContain("fields");
});

// --- status ---------------------------------------------------------------------

test("status reports the key source without printing the key", async () => {
  const { stdout, code } = await run(["status"]);
  expect(code).toBe(0);
  const s = JSON.parse(stdout);
  expect(s.authenticated).toBe(true);
  expect(s.source).toBe("TABSTACK_API_KEY env");
  expect(stdout).not.toContain("test-key");
});

test("status when unauthenticated says so and still exits 0", async () => {
  const { stdout, code } = await run(["status"], {
    env: { TABSTACK_API_KEY: "", TABSTACK_CONFIG_DIR: join(configDir, "status-none") },
  });
  expect(code).toBe(0);
  expect(JSON.parse(stdout).authenticated).toBe(false);
});

// --- recipes ---------------------------------------------------------------------

test("recipes lists all ten, no key or network needed", async () => {
  const { stdout, code } = await run(["recipes", "-o", "pretty"], {
    env: { TABSTACK_API_KEY: "", TABSTACK_BASE_URL: "http://localhost:1" },
  });
  expect(code).toBe(0);
  expect(stdout).toContain("10. The post that fact-checks itself");
});

test("recipes <n> prints a runnable command", async () => {
  const { stdout, code } = await run(["recipes", "9", "-o", "pretty"]);
  expect(code).toBe(0);
  expect(stdout).toContain("--interactive");
  expect(stdout).toContain("tabstack input");
});

test("recipes by name match and as JSON for agents", async () => {
  const { stdout, code } = await run(["recipes", "citation"]);
  expect(code).toBe(0);
  expect(JSON.parse(stdout).n).toBe(6);
});

test("unknown recipe is a usage error (exit 2)", async () => {
  const { stderr, code } = await run(["recipes", "soufflé"]);
  expect(code).toBe(2);
  expect(stderr).toContain("No recipe");
});

// --- skill distribution -----------------------------------------------------------

test("the embedded skill is byte-identical to the repo's SKILL.md", async () => {
  const { SKILL_MD } = await import("../src/skill");
  const onDisk = readFileSync(new URL("../.claude/skills/tabstack/SKILL.md", import.meta.url), "utf8");
  expect(SKILL_MD).toBe(onDisk);
});

test("skill prints the Claude Code skill with frontmatter", async () => {
  const { stdout, code } = await run(["skill"]);
  expect(code).toBe(0);
  expect(stdout).toContain("name: tabstack");
  expect(stdout).toContain("recipes --json");
});

test("skill install writes to ~/.claude/skills/tabstack/SKILL.md", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "tabstack-home-"));
  const { stdout, code } = await run(["skill", "install"], { env: { HOME: fakeHome } });
  expect(code).toBe(0);
  expect(JSON.parse(stdout).installed).toBe(true);
  const installed = join(fakeHome, ".claude", "skills", "tabstack", "SKILL.md");
  expect(readFileSync(installed, "utf8")).toContain("name: tabstack");
  rmSync(fakeHome, { recursive: true, force: true });
});

test("skill agents prints an AGENTS.md-ready section", async () => {
  const { stdout, code } = await run(["skill", "agents"]);
  expect(code).toBe(0);
  expect(stdout).toContain("## tabstack");
  expect(stdout).toContain("recipes --json");
});

// --- usage: ledger, calibration, estimator, sync, 429 retry -----------------------

test("usage learns per-verb cost from two calibrations around logged calls", async () => {
  const dir = join(configDir, "usage-learn");
  const env = { TABSTACK_CONFIG_DIR: dir };
  await run(["usage", "set", "1000"], { env });
  await run(["extract", "markdown", "https://example.com"], { env });
  await run(["extract", "markdown", "https://example.com"], { env });
  const second = await run(["usage", "set", "900"], { env });
  expect(second.code).toBe(0);
  expect(JSON.parse(second.stdout)).toMatchObject({ calibrated: 900, consumed: 100, callsInWindow: 2 });
  const report = await run(["usage"], { env });
  const u = JSON.parse(report.stdout);
  expect(u.learnedCostPerCall.extract.avg).toBe(50);
  expect(u.estimatedRemaining).toBe(900);
  expect(u.totalCallsLogged).toBe(2);
});

test("usage sync scrapes the console with a stored cookie and calibrates", async () => {
  const dir = join(configDir, "usage-sync");
  const env = { TABSTACK_CONFIG_DIR: dir, TABSTACK_CONSOLE_URL: base };
  const ck = await run(["usage", "cookie", "_tabstack_session=good-session"], { env });
  expect(ck.code).toBe(0);
  const sync = await run(["usage", "sync"], { env });
  expect(sync.code).toBe(0);
  expect(JSON.parse(sync.stdout).tokens).toBe(12345);
  const mode = statSync(join(dir, "usage.json")).mode & 0o777;
  expect(mode).toBe(0o600); // the cookie file is owner-only
});

test("usage sync with an expired cookie explains itself", async () => {
  const dir = join(configDir, "usage-expired");
  const env = { TABSTACK_CONFIG_DIR: dir, TABSTACK_CONSOLE_URL: base };
  await run(["usage", "cookie", "_tabstack_session=stale"], { env });
  const { stderr, code } = await run(["usage", "sync"], { env });
  expect(code).toBe(1);
  expect(stderr).toContain("expired");
});

test("usage sync without a cookie tells you how to store one", async () => {
  const { stderr, code } = await run(["usage", "sync"], {
    env: { TABSTACK_CONFIG_DIR: join(configDir, "usage-nocookie"), TABSTACK_CONSOLE_URL: base },
  });
  expect(code).toBe(1);
  expect(stderr).toContain("usage cookie");
});

test("a 429 is retried after the reset and the call succeeds", async () => {
  const { stdout, stderr, code } = await run(["extract", "markdown", "https://flaky429.example.com"]);
  expect(code).toBe(0);
  expect(JSON.parse(stdout).content).toContain("# Hello");
  expect(stderr).toContain("rate limited — retrying");
});

// --- global flags ----------------------------------------------------------------

test("login honors --base-url for the verification call", async () => {
  const loginDir = join(configDir, "login-baseurl");
  const { code } = await run(["login", "--with-key", "good-key", "--base-url", base], {
    // env points somewhere unroutable; success proves the flag won
    env: { TABSTACK_API_KEY: "", TABSTACK_BASE_URL: "http://localhost:1", TABSTACK_CONFIG_DIR: loginDir },
  });
  expect(code).toBe(0);
  expect(JSON.parse(readFileSync(join(loginDir, "config.json"), "utf8")).apiKey).toBe("good-key");
});

test("--base-url flag overrides the env var", async () => {
  const { stdout, code } = await run(["extract", "markdown", "https://example.com", "--base-url", base], {
    env: { TABSTACK_BASE_URL: "http://localhost:1" }, // unroutable unless the flag wins
  });
  expect(code).toBe(0);
  expect(JSON.parse(stdout).content).toContain("# Hello");
});

test("--timeout aborts a slow non-streaming call", async () => {
  const { stderr, code } = await run(["extract", "markdown", "https://slow.example.com", "--timeout", "0.1"]);
  expect(code).toBe(1);
  expect(stderr).toContain("timed out");
});

test("--flag=value syntax works and does not eat the next argument", async () => {
  const { stdout, code } = await run(["extract", "markdown", "https://example.com", "--output=json"]);
  expect(code).toBe(0);
  expect(JSON.parse(stdout).content).toContain("# Hello");
});

test("subcommand --help prints help and exits 0", async () => {
  const { stdout, code } = await run(["research", "--help"]);
  expect(code).toBe(0);
  expect(stdout).toContain("tabstack <command>");
});

test("a non-numeric --fetch-timeout is a usage error, not a null on the wire", async () => {
  const { stderr, code } = await run(["research", "anything", "--fetch-timeout", "abc"]);
  expect(code).toBe(2);
  expect(stderr).toContain("--fetch-timeout");
});

test("an invalid --effort is a usage error (exit 2)", async () => {
  const { stderr, code } = await run(["extract", "markdown", "https://example.com", "--effort", "turbo"]);
  expect(code).toBe(2);
  expect(stderr).toContain("--effort");
});

test("an invalid -o value is a usage error (exit 2)", async () => {
  const { stderr, code } = await run(["extract", "markdown", "https://example.com", "-o", "yaml"]);
  expect(code).toBe(2);
  expect(stderr).toContain("--output");
});
