import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { TerminalApp } from "../lib/tui/app.js";
import { Controller } from "../lib/tui/session.js";
import { tuiCommand } from "../lib/tui/index.js";
import { createTheme } from "../lib/tui/theme.js";
import { stripAnsi, visibleWidth } from "../lib/tui/width.js";
import { emulateScreen, ev, makeFakeDsh, status, textMsg, until } from "./tui-helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OPTIONS = { provider: "gw", model: "example-model-1", effort: "high", permission: "workspace-write", addDirs: [], patches: [], ownedPaths: [] };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const TURN = [
  status("running"), ev({ type: "turn/start", turn: 1 }),
  ev({ type: "assistant/message", turn: 1, step: 1, stream: [], message: textMsg("Hello from the fake harness."), usage: { inputTokens: 100, outputTokens: 20 } }),
  ev({ type: "turn/end", turn: 1, reason: { kind: "completed" } }), status("idle"),
];

function fakeTty({ columns = 80, rows = 24 } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.raw = [];
  stdin.setRawMode = (v) => { stdin.raw.push(v); };
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = columns;
  stdout.rows = rows;
  stdout.written = "";
  stdout.on("data", (d) => { stdout.written += d; });
  return { stdin, stdout };
}

async function boot(scenario, { mode = "none", size } = {}) {
  const fake = makeFakeDsh(scenario);
  const { stdin, stdout } = fakeTty(size);
  const c = new Controller({ bin: fake.bin, args: ["--profile", "sdk"], options: OPTIONS, cwd: process.cwd(), env: fake.env, timing: { killGraceMs: 300, shutdownGraceMs: 1500 } });
  const app = new TerminalApp({ controller: c, stdin, stdout, theme: createTheme({ mode }) });
  const done = app.run();
  await until(() => c.state.childAlive && c.state.phase === "ready" && c.child && fake.received("initialize").length > 0, "ready");
  const text = () => app.last.map((l) => stripAnsi(l).trimEnd());
  const send = (s) => stdin.write(s);
  return { fake, stdin, stdout, c, app, done, text, send };
}

test("the app enters the alternate screen with bracketed paste, shows the empty screen, and restores the terminal on Ctrl-D", async () => {
  const t = await boot({});
  assert.ok(t.stdout.written.startsWith("\x1b[?1049h\x1b[?2004h"), "alternate screen and bracketed paste on");
  assert.deepEqual(t.stdin.raw, [true]);
  const screen = t.text();
  assert.equal(screen.length, 24);
  assert.match(screen[0], /^🥩  STEAK DSH +\/ commands/);
  assert.match(screen.at(-2), /^◆ example-model-1 · high · ● new session/);
  assert.equal(screen.at(-1), "╰─ Message");
  assert.deepEqual(emulateScreen(t.stdout.written, 80, 24), screen, "the bytes written to the terminal draw exactly the composed frame");
  const pid = t.fake.starts()[0].start;
  t.send("\x04");
  assert.equal(await t.done, 0);
  assert.deepEqual(t.stdin.raw, [true, false], "raw mode restored");
  assert.ok(t.stdout.written.endsWith("\x1b[?2004l\x1b[?25h\x1b[?1049l"), "terminal restored");
  assert.ok(!alive(pid), "the child was shut down");
});

test("typing and Enter send a prompt; the transcript, band and spinner timer follow the turn", async () => {
  const t = await boot({ onPrompt: [{ delay: 150 }, ...TURN] });
  t.send("hello there");
  await until(() => t.text().at(-1) === "╰─ hello there", "typed text shown");
  t.send("\r");
  await until(() => t.c.state.busy, "busy");
  assert.ok(t.app.timer, "the 80 ms spinner runs while busy");
  await until(() => t.text().some((l) => /running tool|thinking/.test(l)) || t.c.state.busy, "working line");
  await until(() => t.c.state.phase === "complete", "complete");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(t.app.timer, undefined, "no timer while idle: the band is event-driven");
  const screen = t.text().join("\n");
  assert.match(screen, / hello there\n/);
  assert.match(screen, / Hello from the fake harness\./);
  assert.match(screen, /✓ complete/);
  assert.match(screen, /◫ 0%\/\? ?|120 tok/);
  t.send("\x04");
  await t.done;
});

test("a bracketed paste with newlines is inserted, not sent; Ctrl-C clears a non-empty editor before it quits", async () => {
  const t = await boot({});
  t.send("\x1b[200~line one\nline two\x1b[201~");
  await until(() => t.text().some((l) => l === "   line two"), "pasted lines shown");
  assert.equal(t.fake.received("session/prompt").length, 0, "a paste never submits");
  t.send("\x03");
  await until(() => t.text().at(-1) === "╰─ Message", "cleared");
  t.send("\x03");
  assert.equal(await t.done, 0);
});

test("Esc cancels a running turn: SIGINT, respawn, resume; the screen reports stopped · cancelled", async () => {
  const t = await boot({ onPrompt: [status("running"), ev({ type: "turn/start", turn: 1 }), { hang: true }] });
  t.send("work\r");
  await until(() => t.c.state.busy, "busy");
  await until(() => t.fake.received("session/prompt").length === 1, "prompt sent");
  t.send("\x1b");
  await until(() => t.c.state.detail === "cancelled" && t.c.child && !t.c.cancelling, "cancelled and respawned");
  assert.equal(t.fake.starts().length, 2);
  assert.equal(t.fake.received("session/resume").length, 1);
  assert.match(t.text().join("\n"), /! stopped · cancelled/);
  assert.ok(t.fake.entries().some((e) => e.sigint));
  t.send("\x04");
  await t.done;
});

test("approval via keys: y allows once; the harness receives the decision", async () => {
  const t = await boot({ onPrompt: [status("running"), { request: { method: "approval/request", params: { sessionId: "$SESSION", toolName: "bash", reason: "run it" } }, name: "ap" }] });
  t.send("go\r");
  await until(() => t.c.state.prompt, "prompt");
  await until(() => t.text().some((l) => l.includes("confirm · bash")), "selector drawn");
  assert.match(t.text().join("\n"), /◇ waiting · bash/);
  t.send("y");
  await until(() => t.fake.entries().some((e) => e.answer === "ap"), "answer");
  assert.deepEqual(t.fake.entries().find((e) => e.answer === "ap").result, { outcome: "allowed-once" });
  t.send("\x03");
  await until(() => !t.c.state.prompt, "prompt closed");
  t.send("\x04");
  await t.done;
});

test("resize: the next frame uses the new size, the screen is cleared and the header hints are width-gated", async () => {
  const t = await boot({}, { size: { columns: 120, rows: 30 } });
  assert.equal(t.app.last.length, 30);
  assert.match(t.text()[0], /\/ commands · \/new · \/compact · \/exit$/);
  const before = t.stdout.written.length;
  t.stdout.columns = 38;
  t.stdout.rows = 12;
  t.stdout.emit("resize");
  await until(() => t.app.last.length === 12, "repainted");
  assert.ok(t.stdout.written.slice(before).includes("\x1b[2J"), "cleared before the repaint");
  assert.ok(t.app.last.every((l) => visibleWidth(l) <= 38));
  assert.equal(t.text()[0], "🥩  STEAK DSH");
  t.send("\x04");
  await t.done;
});

test("NO_COLOR / plain theme: the frame lines carry no colour, and the colour theme does", async () => {
  const plain = await boot({});
  assert.ok(!plain.app.last.join("").includes("\x1b"));
  plain.send("\x04");
  await plain.done;
  const coloured = await boot({}, { mode: "truecolor" });
  assert.ok(coloured.app.last.join("").includes("\x1b[38;2;230;57;70m"), "accent is the Steak red");
  coloured.send("\x04");
  await coloured.done;
});

test("child crash while idle: the screen shows the error and the next message restarts and resumes", async () => {
  const t = await boot({ onPrompt: [{ crash: "SIGKILL", onStart: 0 }, ...TURN.map((s) => ({ ...s, onStart: 1 }))] });
  t.send("one\r");
  await until(() => !t.c.state.childAlive, "crash");
  await until(() => /! error · harness exited/.test(t.text().join("\n")), "error on screen");
  t.send("two\r");
  await until(() => t.c.state.phase === "complete", "second turn completes on the new child");
  assert.equal(t.fake.starts().length, 2);
  t.send("\x04");
  await t.done;
});

// ---- plain (non-TTY) mode ------------------------------------------------------------------------------------

function run(args, { input, env, cwd = root }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, "bin", "steak-dsh"), ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, out, err }));
    if (input !== undefined) child.stdin.end(input);
  });
}

test("steak-dsh tui on a pipe: plain lines, no escape sequences, messages come from stdin, EOF ends the session", async () => {
  const fake = makeFakeDsh({ onPrompt: TURN });
  const r = await run(["tui", "--model", "gw/example-model-1", "--effort", "high"], { input: "hello\n", env: { ...fake.env, STEAK_DSH_DSH_BIN: fake.bin } });
  assert.equal(r.code, 0, r.err);
  assert.ok(!r.out.includes("\x1b"), "a pipe never sees an escape sequence");
  assert.match(r.out, /◆ example-model-1 · high · ● new session/);
  assert.match(r.out, /^ hello$/m);
  assert.match(r.out, /Hello from the fake harness\./);
  assert.match(r.out, /✓ complete/);
  const init = fake.received("initialize")[0].params;
  assert.equal(init.model, "example-model-1");
  assert.ok(fake.starts()[0].argv.includes("--profile") && fake.starts()[0].argv.includes("sdk"));
  assert.ok(fake.starts()[0].argv.includes(join(root, "cordis.patch.yml")), "the bundle patch is passed to the sdk profile");
  assert.ok(!alive(fake.starts()[0].start));
});

test("steak-dsh tui on a pipe refuses approvals: nothing can be allowed without a terminal", async () => {
  const fake = makeFakeDsh({ onPrompt: [status("running"), { request: { method: "approval/request", params: { sessionId: "$SESSION", toolName: "bash" } }, name: "ap" }, ev({ type: "turn/end", turn: 1, reason: { kind: "completed" } }), status("idle")] });
  const r = await run(["tui", "--model", "gw/m", "--long"], { input: "run it\n", env: { ...fake.env, STEAK_DSH_DSH_BIN: fake.bin } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(fake.entries().find((e) => e.answer === "ap").result, { outcome: "rejected" });
  assert.ok(fake.starts()[0].argv.includes(join(root, "long.patch.yml")), "--long adds the long-work patch");
});

test("steak-dsh tui usage errors: needs --model, takes no task words, rejects --json", async () => {
  const fake = makeFakeDsh({});
  const env = { ...fake.env, STEAK_DSH_DSH_BIN: fake.bin };
  const a = await run(["tui"], { input: "", env });
  assert.equal(a.code, 2);
  assert.match(a.err, /tui needs --model/);
  const b = await run(["tui", "--model", "a/b", "words"], { input: "", env });
  assert.equal(b.code, 2);
  assert.match(b.err, /tui takes no task arguments/);
  const c = await run(["tui", "--model", "a/b", "--json"], { input: "", env });
  assert.equal(c.code, 2);
  assert.equal(fake.starts().length, 0, "no child is started for a usage error");
});

test("tuiCommand with a TTY pair runs the full-screen app", async () => {
  const fake = makeFakeDsh({});
  const { stdin, stdout } = fakeTty();
  const run1 = tuiCommand({ ...OPTIONS, stock: true }, { root, bin: fake.bin, stdin, stdout, env: { ...fake.env, NO_COLOR: "1" } });
  await until(() => stdout.written.includes("STEAK DSH"), "screen drawn");
  await until(() => fake.received("initialize").length === 1, "initialized");
  stdin.write("\x04");
  assert.equal(await run1, 0);
  assert.ok(!alive(fake.starts()[0].start));
});
