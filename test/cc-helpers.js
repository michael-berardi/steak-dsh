// Shared helpers for the Claude Code route tests: the fake CLI, a fake upstream, process checks.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FAKE = join(root, "test", "fixtures", "fake-claude.mjs");

const { createClaudeCodeAdapter } = await import(join(root, "claude-code", "adapter.js"));
const { loadHarness } = await import(join(root, "claude-code", "harness.js"));
const { liveClaudeWorkerCount, closeClaudeProcesses, resetClaudeStatusCache } = await import(join(root, "claude-code", "claude-cli.js"));
export { liveClaudeWorkerCount, closeClaudeProcesses, resetClaudeStatusCache };

/** Launch the fake once, outside any timed call: macOS scans a new executable on its first launch (250 to 680 ms). */
export function warmFake() {
  const result = spawnSync(FAKE, ["auth", "status"], { encoding: "utf8", timeout: 20_000 });
  if (result.status !== 0) throw new Error(`fake claude did not start: ${result.stderr}`);
}

export const harness = await loadHarness({ entry: "/nonexistent" }); // the local contract: tests do not need the installed harness

export function scratchDir(prefix = "steak-dsh-cc-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A route adapter whose CLI is the fake, with FAKE_CLAUDE_* settings and extra environment. */
export function makeAdapter(dir, fakeEnv = {}, settings = {}) {
  const log = join(dir, "fake.log");
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    STEAK_DSH_CLAUDE_CODE_COMMAND: FAKE,
    FAKE_CLAUDE_LOG: log,
    ...fakeEnv,
  };
  return { adapter: createClaudeCodeAdapter(harness, { env: () => env, ...settings }), log, env };
}

export function readLog(log) {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export const user = (text) => ({ role: "user", id: "u", source: { kind: "user" }, content: [{ type: "text", text }] });
export const system = (text) => ({ role: "system", id: "s", source: { kind: "system-prompt" }, content: [{ type: "text", text }] });

export function request(messages, extra = {}) {
  return { provider: "claude-code", model: "default", messages: [system("be brief"), ...messages], tools: [], ...extra };
}

export async function collect(adapter, options) {
  const chunks = [];
  for await (const chunk of adapter.stream(options)) chunks.push(chunk);
  return chunks;
}

export async function failure(adapter, options) {
  try {
    await collect(adapter, options);
  } catch (error) {
    return error;
  }
  throw new Error("expected the request to fail");
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

export async function waitFor(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

/** PIDs of the direct children of this process (PIDs only, never command lines). */
export function childPids() {
  const result = spawnSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" });
  return result.stdout.split("\n").filter(Boolean).map(Number);
}

/** A loopback server standing in for the vendor API: answers each request with `respond(request, body)`. */
export async function startUpstream(respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method, url: req.url, body });
      respond(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

/** An Anthropic-style SSE reply: one text block. */
export function sseText(res, text, { usage = { input_tokens: 9, output_tokens: 4 } } = {}) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", { message: { id: "msg_up", type: "message", role: "assistant", content: [], model: "m", stop_reason: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } });
  send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: usage.output_tokens } });
  send("message_stop", {});
  res.end();
}
