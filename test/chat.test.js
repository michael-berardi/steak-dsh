import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, renderEvent, shortArgs } from "../lib/render.js";

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
