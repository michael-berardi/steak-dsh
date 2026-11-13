/**
 * Test helpers for the TUI: a fake `dsh --profile sdk` child (a regular Node script written into a fresh temp dir)
 * that plays scripted sessions over NDJSON JSON-RPC, and small utilities. No model is ever contacted.
 *
 * Scenario (JSON, path in FAKE_DSH_SCENARIO):
 *   initialize: { error?: {code,message}, delayMs? }
 *   resume:     { error?: {code,message} }
 *   onPrompt / onQuery: [ step ... ] run after the reply, in order. A step is one of
 *     { notify: { method, params } }  send a notification        ($SESSION is replaced by the prompt's session id)
 *     { request: { method, params }, name, noWait? } send a server request and log the client's answer under `name`
 *     { onStart: n } on any step: run it only in the n-th spawned child (0-based)
 *     { delay: ms } | { exit: code } | { crash: signal } | { stderr: text } | { hang: true }
 * stubbornShutdown: true ignores `shutdown` and stdin EOF (only SIGTERM ends it).
 * ignoreSigint: true makes the child survive SIGINT (the controller must escalate).
 * Everything the child receives or answers is appended to FAKE_DSH_LOG as JSON lines.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const log = (entry) => { if (process.env.FAKE_DSH_LOG) fs.appendFileSync(process.env.FAKE_DSH_LOG, JSON.stringify(entry) + "\n"); };
const scenario = process.env.FAKE_DSH_SCENARIO ? JSON.parse(fs.readFileSync(process.env.FAKE_DSH_SCENARIO, "utf8")) : {};
const startIndex = fs.existsSync(process.env.FAKE_DSH_LOG || "") ? fs.readFileSync(process.env.FAKE_DSH_LOG, "utf8").split("\n").filter((l) => l.includes('"start"')).length : 0;
log({ start: process.pid, argv: process.argv.slice(2), hostEnv: Object.keys(process.env).filter((k) => ["ULTRATERM_UI_TRANSCRIPT_FILE", "ULTRATERM_UI_SESSION_ID", "ULTRATERM_MAIN_SCREEN"].includes(k)) });
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const waiting = new Map();
let nextId = 9000;
let session = "";
const sub = (value) => JSON.parse(JSON.stringify(value).replace(/\$SESSION/g, session));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function play(steps) {
  for (const step of steps ?? []) {
    if (step.onStart !== undefined && step.onStart !== startIndex) continue;
    if (step.delay) await sleep(step.delay);
    if (step.notify) send(sub(step.notify));
    if (step.stderr) process.stderr.write(step.stderr);
    if (step.request) {
      const id = nextId++;
      const answer = new Promise((resolve) => waiting.set(id, resolve));
      send({ id, ...sub(step.request) });
      if (!step.noWait) {
        const result = await answer;
        log({ answer: step.name ?? step.request.method, result });
      }
    }
    if (step.exit !== undefined) process.exit(step.exit);
    if (step.crash) process.kill(process.pid, step.crash);
    if (step.hang) await new Promise(() => {});
  }
}
let buffer = "";
if (scenario.stubbornShutdown) setInterval(() => {}, 1000);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let n;
  while ((n = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, n);
    buffer = buffer.slice(n + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => { log({ stdinEnd: true }); if (!scenario.stubbornShutdown) process.exit(0); });
process.on("SIGINT", () => { log({ sigint: true }); if (!scenario.ignoreSigint) process.exit(0); });
process.on("SIGTERM", () => { log({ sigterm: true }); process.exit(0); });
async function handle(msg) {
  if (msg.method === undefined) { // response to one of our requests
    const resolve = waiting.get(msg.id);
    if (resolve) { waiting.delete(msg.id); resolve(msg.error ? { error: msg.error } : msg.result); }
    return;
  }
  log({ in: msg });
  const fail = (e) => send({ id: msg.id, error: e });
  switch (msg.method) {
    case "initialize": {
      if (scenario.initialize?.delayMs) await sleep(scenario.initialize.delayMs);
      if (scenario.initialize?.error) return fail(scenario.initialize.error);
      return send({ id: msg.id, result: { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } } });
    }
    case "session/resume":
      session = msg.params.sessionId;
      if (scenario.resume?.error) return fail(scenario.resume.error);
      return send({ id: msg.id, result: {} });
    case "session/prompt":
      session = msg.params.sessionId;
      send({ id: msg.id, result: { messageId: "m-" + nextId } });
      return play(scenario.onPrompt);
    case "session/query":
      session = msg.params.sessionId;
      send({ id: msg.id, result: { kind: "command", execution: { commandId: "c1" } } });
      return play(scenario.onQuery);
    case "shutdown":
      if (scenario.stubbornShutdown) return; // never answers; ignores stdin EOF; only SIGTERM stops it
      send({ id: msg.id, result: {} });
      return setTimeout(() => process.exit(0), 5);
    default:
      return fail({ code: -32601, message: "method not found: " + msg.method });
  }
}
`;

/** Write the fake dsh into a fresh temp dir. Returns { dir, bin, log(), scenario(obj), env, entries() }. */
export function makeFakeDsh(scenario = {}) {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-fake-"));
  const bin = join(dir, "dsh");
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  // The fake is an extensionless CommonJS script. Node reads its module type from the nearest package.json, so a
  // temp folder inside this repository (TMPDIR set by scripts/test-install.sh) would load it as an ES module and
  // fail on `require`. Its own package.json makes it CommonJS wherever the temp folder is.
  writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}\n');
  process.once("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const scenarioPath = join(dir, "scenario.json");
  const logPath = join(dir, "log.jsonl");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const entries = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    dir, bin, logPath, scenarioPath,
    env: { ...process.env, FAKE_DSH_SCENARIO: scenarioPath, FAKE_DSH_LOG: logPath, DSH_TELEMETRY_MODE: "DISABLED" },
    entries,
    starts: () => entries().filter((e) => e.start && !e.argv.includes("--version")),
    received: (method) => entries().filter((e) => e.in?.method === method).map((e) => e.in),
  };
}

/** Poll until `fn()` is truthy, up to `ms`. Throws with `what` on timeout. */
export async function until(fn, what = "condition", ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** A session.event notification for the scripted scenarios. */
export const ev = (event) => ({ notify: { method: "session.event", params: { sessionId: "$SESSION", event } } });
export const status = (value) => ({ notify: { method: "session.status", params: { sessionId: "$SESSION", status: value } } });
export const textMsg = (text, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], ...extra });
export const toolResult = (callId, text, isError = false) => ({ role: "tool", toolCallId: callId, isError: isError || undefined, content: [{ type: "text", text }] });

/**
 * A tiny terminal emulator for the TUI's own output (cursor positioning, erase, SGR and mode switches only):
 * turns the raw bytes written to a terminal into the rows a user would see. Used to prove the byte stream
 * reproduces the composed frame, and to capture real screens for the docs.
 */
export function emulateScreen(raw, columns, rows) {
  const grid = Array.from({ length: rows }, () => []);
  let r = 0;
  let c = 0;
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const wide = (g) => /\p{Extended_Pictographic}|[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/u.test(g) && !/^[─-╿▀-▟■-◿☀-★←-⇿]$/u.test(g);
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === "\x1b" && raw[i + 1] === "[") {
      const m = /^\x1b\[([0-9;?]*)([@-~])/.exec(raw.slice(i));
      if (!m) break;
      i += m[0].length;
      const nums = m[1].replace("?", "").split(";").map((n) => Number(n) || 0);
      if (m[2] === "H") { r = Math.max(0, (nums[0] || 1) - 1); c = Math.max(0, (nums[1] || 1) - 1); }
      else if (m[2] === "K") { if (r < rows) grid[r].length = Math.min(grid[r].length, c); }
      else if (m[2] === "J" && nums[0] === 2) for (const row of grid) row.length = 0;
      continue;
    }
    const next = raw.indexOf("\x1b", i + 1);
    const chunk = raw.slice(i, next < 0 ? raw.length : next);
    i += chunk.length;
    for (const { segment: g } of seg.segment(chunk)) {
      if (g === "\n" || g === "\r") continue;
      if (r < rows) { while (grid[r].length < c) grid[r].push(" "); grid[r][c] = g; if (wide(g)) { grid[r][c + 1] = ""; c += 1; } }
      c += 1;
    }
  }
  return grid.map((row) => row.join("").replace(/\s+$/, ""));
}
