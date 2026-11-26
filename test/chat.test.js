import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, renderEvent, shortArgs } from "../lib/render.js";

const hasDsh = spawnSync("dsh", ["--version"], { encoding: "utf8" }).status === 0;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(root, "bin", "steak-dsh");

const EVENTS = [
  { type: "session", sessionId: "sess-1", cwd: "/repo" },
  { type: "status", phase: "turn_start", turn: 1 },
  { type: "text", text: "I will run the tests." },
  { type: "tool_call", callId: "c1", tool: "bash", input: { command: "npm test", description: "Run tests" } },
  { type: "tool_result", callId: "c1", status: "completed", result: "all pass" },
  { type: "tool_call", callId: "c2", tool: "write", input: { file_path: "/repo/b.txt", content: "no" } },
  { type: "tool_result", callId: "c2", status: "error", result: "Error: steak-dsh: /repo/b.txt is outside this task's owned paths (/repo/allowed)" },
  { type: "status", phase: "step_end", turn: 1, step: 1, usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 } },
  { type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } },
  { type: "final", sessionId: "sess-1", reason: { kind: "completed" }, text: "Done." },
];

test("render(): plain text, dim tool lines, red errors, closing turn/token line", () => {
  assert.deepEqual(render(EVENTS), [
    "I will run the tests.",
    "> bash: npm test",
    "> write: /repo/b.txt",
    "! Error: steak-dsh: /repo/b.txt is outside this task's owned paths (/repo/allowed)",
    "1 turn, 1500 tokens",
  ]);
  const colored = render(EVENTS, { color: true });
  assert.equal(colored[0], "I will run the tests.", "assistant text stays plain");
  assert.equal(colored[1], "\x1b[2m> bash: npm test\x1b[0m");
  assert.match(colored[3], /^\x1b\[31m! Error: /);
  assert.equal(colored[4], "\x1b[2m1 turn, 1500 tokens\x1b[0m");
});

test("render(): error events, multiple turns, missing usage, empty streams", () => {
  assert.deepEqual(renderEvent({ type: "error", message: "boom" }), ["error: boom"]);
  assert.deepEqual(render([]), ["0 turns, 0 tokens"]);
  const two = render([
    { type: "status", phase: "turn_end", turn: 1 },
    { type: "status", phase: "step_end", usage: { inputTokens: 10, outputTokens: 5 } },
    { type: "status", phase: "turn_end", turn: 2 },
  ]);
  assert.equal(two.at(-1), "2 turns, 15 tokens", "usage falls back to input+output");
  assert.deepEqual(renderEvent({ type: "thinking", text: "hmm" }), [], "thinking is not rendered");
  assert.deepEqual(renderEvent({ type: "tool_result", status: "completed", result: "ok" }), []);
});

test("shortArgs(): representative argument, whitespace collapsed, long values clipped", () => {
  assert.equal(shortArgs({ command: "npm   test\n" }), "npm test");
  assert.equal(shortArgs({ file_path: "/a/b" }), "/a/b");
  assert.equal(shortArgs({ other: "x".repeat(200) }).length, 80);
  assert.equal(shortArgs(undefined), "");
  assert.equal(shortArgs({ n: 3 }), "{\"n\":3}");
});

const FAKE_DSH = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv[0] === "--version") { process.stdout.write("0.2.2-rc.1\\n"); process.exit(0); }
const patches = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === "--patch") patches.push({ path: argv[i + 1], content: readFileSync(argv[i + 1], "utf8") });
appendFileSync(process.env.FAKE_DSH_RECORD, JSON.stringify({ argv, patches }) + "\\n");
const events = [
  { type: "session", sessionId: "sess-1", cwd: process.cwd() },
  { type: "text", text: "canned reply" },
  { type: "status", phase: "step_end", turn: 1, step: 1, usage: { totalTokens: 1500 } },
  { type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } },
  { type: "final", sessionId: "sess-1", reason: { kind: "completed" }, text: "canned reply" },
];
for (const event of events) process.stdout.write(JSON.stringify(event) + "\\n");
process.exit(0);
`;

test("chat: two scripted turns; the second turn continues the first turn's session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-chat-test-"));
  try {
    const fake = join(dir, "fake-dsh.mjs");
    const record = join(dir, "record.jsonl");
    writeFileSync(fake, FAKE_DSH, { mode: 0o755 });
    const child = spawn(process.execPath, [launcher, "chat", "--model", "acme/m"], {
      cwd: dir,
      env: { ...process.env, STEAK_DSH_DSH_BIN: fake, FAKE_DSH_RECORD: record, DSH_HOME: join(dir, "home") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.write("hello\nworld\n/exit\n");
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`chat timed out; stdout: ${stdout}`)); }, 30_000);
      child.on("close", (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 0, stderr);
    const turns = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(turns.length, 2, "one headless run per line");
    assert.equal(turns[0].argv.at(-1), "hello");
    assert.equal(turns[1].argv.at(-1), "world");
    assert.ok(turns[0].argv.includes("--json"), "chat always uses --json");
    assert.equal(turns[0].argv.includes("--session-id"), false, "first turn starts a session");
    const at = turns[1].argv.indexOf("--session-id");
    assert.ok(at >= 0, "second turn passes --session-id");
    assert.equal(turns[1].argv[at + 1], "sess-1", "the id from the first session event");
    assert.equal(stdout.includes("canned reply"), true);
    assert.equal(stdout.includes("1 turn, 1500 tokens"), true);
    assert.equal(stdout.includes("\x1b["), false, "no colour when stdout is not a TTY");
    const overlay = turns[0].patches.find((p) => p.path.endsWith("overlay.yml"));
    assert.ok(overlay, "chat applies the generated overlay");
    assert.equal(existsSync(overlay.path), false, "overlay removed when chat exits");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chat: a line that looks like a flag (--help) is sent as task text after --", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-chat-test-"));
  try {
    const fake = join(dir, "fake-dsh.mjs");
    const record = join(dir, "record.jsonl");
    writeFileSync(fake, FAKE_DSH, { mode: 0o755 });
    const child = spawn(process.execPath, [launcher, "chat", "--model", "acme/m"], {
      cwd: dir,
      env: { ...process.env, STEAK_DSH_DSH_BIN: fake, FAKE_DSH_RECORD: record, DSH_HOME: join(dir, "home") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.write("--help\n/exit\n");
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`chat timed out; stdout: ${stdout}`)); }, 30_000);
      child.on("close", (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 0, stderr);
    const turns = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(turns.length, 1);
    const at = turns[0].argv.indexOf("--");
    assert.ok(at >= 0, "the task words are separated by --");
    assert.deepEqual(turns[0].argv.slice(at), ["--", "--help"], "--help is task text, not a dsh flag");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chat: /model switches models in place, rewrites the overlay, and keeps the same session id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-chat-model-"));
  try {
    const fake = join(dir, "fake-dsh.mjs");
    const record = join(dir, "record.jsonl");
    writeFileSync(fake, FAKE_DSH, { mode: 0o755 });
    const child = spawn(process.execPath, [
      launcher, "chat", "--model", "acme/m1", "--base-url", "https://gw.example/v1",
      "--api", "openai-completions", "--key-env", "STEAK_CHAT_KEY",
    ], {
      cwd: dir,
      env: { ...process.env, STEAK_DSH_DSH_BIN: fake, FAKE_DSH_RECORD: record, DSH_HOME: join(dir, "home"), STEAK_CHAT_KEY: "test-key" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.write("first turn\n/model\n/model bad-no-slash\n/model acme/m2\nsecond turn\n/model beta/org/m3\nthird turn\n/exit\n");
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`chat timed out; stdout: ${stdout}`)); }, 30_000);
      child.on("close", (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /current model: acme\/m1/);
    assert.match(stdout, /error: \/model must be <provider>\/<model-id>, got "bad-no-slash"/);
    assert.match(stdout, /switched model to acme\/m2 \(session sess-1\)/);
    assert.match(stdout, /switched model to beta\/org\/m3 \(session sess-1\)/);
    const turns = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(turns.length, 3, "three actual turns ran");
    const overlayRows = (turn) => JSON.parse(turn.patches.find((p) => p.path.endsWith("overlay.yml")).content);
    const r0 = overlayRows(turns[0]);
    const r1 = overlayRows(turns[1]);
    const r2 = overlayRows(turns[2]);
    assert.deepEqual(r0.find((r) => r.id === "agent-default-model").config, { provider: "acme", model: "m1" });
    assert.ok(r0.some((r) => r.id === "llm-pi-ai"), "first turn keeps gateway route");
    assert.deepEqual(r1.find((r) => r.id === "agent-default-model").config, { provider: "acme", model: "m2" });
    assert.ok(r1.some((r) => r.id === "llm-pi-ai"), "same-provider switch keeps gateway route");
    assert.deepEqual(r2.find((r) => r.id === "agent-default-model").config, { provider: "beta", model: "org/m3" });
    assert.equal(r2.some((r) => r.id === "llm-pi-ai"), false, "cross-provider switch drops old gateway route");
    assert.equal(turns[1].argv[turns[1].argv.indexOf("--session-id") + 1], "sess-1", "second turn keeps sessionId");
    assert.equal(turns[2].argv[turns[2].argv.indexOf("--session-id") + 1], "sess-1", "third turn keeps sessionId");
    for (const turn of turns) {
      const overlay = turn.patches.find((p) => p.path.endsWith("overlay.yml"));
      assert.equal(existsSync(overlay.path), false, "all generated overlays cleaned up on exit");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chat: /model refuses local/, removed routes, and bundle routes under --stock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-chat-route-rules-"));
  try {
    const fake = join(dir, "fake-dsh.mjs");
    const record = join(dir, "record.jsonl");
    writeFileSync(fake, FAKE_DSH, { mode: 0o755 });
    const child = spawn(process.execPath, [launcher, "chat", "--stock", "--model", "acme/m1"], {
      cwd: dir,
      env: { ...process.env, STEAK_DSH_DSH_BIN: fake, FAKE_DSH_RECORD: record, DSH_HOME: join(dir, "home") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.write("/model local/m1\n/model antigravity/x\n/model claude-code/x\nhello\n/exit\n");
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`chat timed out; stdout: ${stdout}`)); }, 30_000);
      child.on("close", (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /cannot switch to or from local/);
    assert.match(stdout, /removed/i);
    assert.match(stdout, /--stock leaves out/);
    const [turn] = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const rows = JSON.parse(turn.patches.find((p) => p.path.endsWith("overlay.yml")).content);
    assert.deepEqual(rows.find((r) => r.id === "agent-default-model").config, { provider: "acme", model: "m1" }, "refused switches kept original model");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("real dsh chat: /model switches to the new model on the next turn while preserving conversation history", { skip: !hasDsh }, async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push({ model: parsed.model, messages: parsed.messages });
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      const chunk = (delta, finish, extra = {}) => ({ id: "x", object: "chat.completion.chunk", model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "chat-" + parsed.model }, null))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({}, "stop", { usage }))}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-real-chat-model-"));
  const work = join(dir, "w");
  mkdirSync(work);
  try {
    const child = spawn(process.execPath, [
      launcher, "chat", "--model", "gw/model-one", "--base-url", `http://127.0.0.1:${port}/v1`,
      "--api", "openai-completions", "--key-env", "FAKE_KEY", "--compat", '{"supportsDeveloperRole":false}',
      "--context-window", "100000", "--no-shell",
    ], {
      cwd: work,
      env: { ...process.env, FAKE_KEY: "x", DSH_HOME: join(dir, "home"), DSH_TELEMETRY_MODE: "DISABLED" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.stdin.write("remember-chat-beta\n/model gw/model-two\nfollow up\n/exit\n");
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`real chat timed out; stdout: ${stdout}; stderr: ${stderr}`)); }, 60_000);
      child.on("close", (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 0, stderr);
    assert.equal(requests.length, 2, `expected 2 model requests, got ${requests.length}`);
    assert.equal(requests[0].model, "model-one");
    assert.equal(requests[1].model, "model-two", "second turn reached model-two");
    assert.match(JSON.stringify(requests[1].messages), /remember-chat-beta/, "second turn preserved turn 1 conversation history");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
