import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Controller } from "../lib/tui/session.js";
import { MAX_ROW, MAX_TEXT, transcriptFromEnv } from "../lib/tui/transcript-publisher.js";
import { launchEnv } from "../lib/dsh.js";
import { tuiCommand } from "../lib/tui/index.js";
import { Readable, Writable } from "node:stream";
import { ev, makeFakeDsh, status, textMsg, toolResult, until } from "./tui-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const OPTIONS = { provider: "gw", model: "example-model-1", effort: "high", permission: "workspace-write", addDirs: [], patches: [], ownedPaths: [], price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
const isRoot = process.getuid?.() === 0;

const call = (turn, step, callId, name, args) => ev({ type: "tool/call", turn, step, callId, name, arguments: JSON.stringify(args) });
const FULL_TURN = [
  status("running"), ev({ type: "turn/start", turn: 1 }),
  ev({ type: "assistant/message", turn: 1, step: 1, stream: [], usage: { inputTokens: 2100, outputTokens: 180, cacheReadTokens: 8800 }, message: { role: "assistant", content: [
    { type: "reasoning", text: "private reasoning that must never be published" },
    { type: "text", text: "I'll read the pane first." },
  ] } }),
  call(1, 1, "c1", "read", { file_path: "src/pane.js" }),
  ev({ type: "tool/result", turn: 1, step: 1, message: toolResult("c1", Array.from({ length: 14 }, (_, i) => `${i + 1}: line ${i + 1} of the file`).join("\n")) }),
  call(1, 2, "c2", "edit", { file_path: "src/pane.js", old_string: "const gap = 1;", new_string: "const gap = 2;" }),
  ev({ type: "tool/result", turn: 1, step: 2, message: toolResult("c2", "Edit applied."), meta: { diffs: [{ path: "src/pane.js", oldText: "a", newText: "b", oldStart: 1, newStart: 1 }] } }),
  call(1, 3, "c3", "bash", { command: "npm test -- --grep pane" }),
  ev({ type: "tool/result", turn: 1, step: 3, message: toolResult("c3", "exit 1", true), error: { name: "ToolError", code: "EXIT_NONZERO", reason: "1 test failed" } }),
  ev({ type: "assistant/message", turn: 1, step: 4, stream: [], usage: { inputTokens: 3000, outputTokens: 420, cacheReadTokens: 9100 }, message: textMsg("## Result\n\nThe gap is now **2 columns**.") }),
  ev({ type: "turn/end", turn: 1, reason: { kind: "completed" } }), status("idle"),
];
const SHORT_TURN = [
  status("running"), ev({ type: "turn/start", turn: 1 }),
  ev({ type: "assistant/message", turn: 1, step: 1, stream: [], message: textMsg("Short answer."), usage: { inputTokens: 10, outputTokens: 5 } }),
  ev({ type: "turn/end", turn: 1, reason: { kind: "completed" } }), status("idle"),
];

/** A fresh fake home with the contract's folder layout and a controller wired to a publisher. */
function rig(scenario, { env = {}, prepare, publish = true, options = OPTIONS } = {}) {
  const home = mkdtempSync(join(tmpdir(), "steak-dsh-pub-"));
  const cwd = join(home, "work");
  mkdirSync(cwd);
  const id = randomUUID();
  mkdirSync(join(home, ".ultraterm"), { mode: 0o700 });
  const dir = join(home, ".ultraterm", "ui-transcripts");
  const file = join(dir, `${id}.jsonl`);
  prepare?.({ home, dir, file, id });
  let tick = 0;
  const publisher = publish ? transcriptFromEnv({ ULTRATERM_UI_TRANSCRIPT_FILE: file, ULTRATERM_UI_SESSION_ID: id, ...env }, { cwd, now: () => 1700000000000 + 1000 * tick++ }) : undefined;
  const fake = makeFakeDsh(scenario);
  const c = new Controller({ bin: fake.bin, args: ["--profile", "sdk"], options, cwd, env: fake.env, publisher, timing: { killGraceMs: 300, shutdownGraceMs: 1500 } });
  const rows = () => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const turn = async (text) => {
    const before = c.state.blocks.length;
    await c.submit(text);
    await until(() => c.state.phase === "complete" && !c.state.busy && c.state.blocks.length > before, "turn complete");
  };
  const notices = () => c.state.blocks.filter((b) => b.kind === "notice" && /transcript/i.test(b.text));
  return { home, cwd, id, dir, file, c, fake, rows, turn, notices };
}

/** Replace the counter ids with i1..iN after checking they are unique and chained through parentId. */
function normalise(rows) {
  const seen = new Map();
  rows.forEach((row, i) => {
    assert.equal(typeof row.id, "string");
    assert.ok(!seen.has(row.id), `row id ${row.id} is unique`);
    seen.set(row.id, `i${i + 1}`);
    assert.equal(row.parentId, i === 0 ? null : rows[i - 1].id, "parentId is the previous row's id");
  });
  return rows.map((row) => ({ ...row, id: seen.get(row.id), parentId: row.parentId === null ? null : seen.get(row.parentId) }));
}

test("a full scripted turn publishes exactly the golden rows after a header carrying the session id", async () => {
  const t = rig({ onPrompt: FULL_TURN });
  await t.c.start();
  assert.deepEqual(t.rows(), [{ type: "session", version: 3, id: t.id, cwd: t.cwd }], "the header is written at launch");
  await t.turn("Refine the pane layout.\nKeep the gap at 2 columns.");
  await t.c.quit();
  const [header, ...rows] = t.rows();
  assert.deepEqual(header, { type: "session", version: 3, id: t.id, cwd: t.cwd });
  const golden = readFileSync(join(here, "golden", "tui-transcript.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(normalise(rows), golden);
  assert.ok(!readFileSync(t.file, "utf8").includes("private reasoning"), "reasoning is not published");
});

test("the file is append-only whole lines, mode 0600, in a 0700 folder; every line parses", async () => {
  const t = rig({ onPrompt: SHORT_TURN });
  await t.c.start();
  await t.turn("hi");
  await t.c.quit();
  const raw = readFileSync(t.file, "utf8");
  assert.ok(raw.endsWith("\n"));
  for (const line of raw.slice(0, -1).split("\n")) assert.doesNotThrow(() => JSON.parse(line));
  assert.equal(statSync(t.file).mode & 0o777, 0o600);
  assert.equal(statSync(t.dir).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(t.dir), [`${t.id}.jsonl`], "no temp file is left beside it");
});

test("usage is published in Pi's shape; cost.total only when the session has a price", async () => {
  const priced = rig({ onPrompt: SHORT_TURN });
  await priced.c.start();
  await priced.turn("hi");
  const row = priced.rows().find((r) => r.message?.role === "assistant" && r.message.content.length);
  assert.deepEqual(row.message.usage, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.000105 } });
  const unpriced = rig({ onPrompt: SHORT_TURN }, { options: { ...OPTIONS, price: undefined } });
  await unpriced.c.start();
  await unpriced.turn("hi");
  const row2 = unpriced.rows().find((r) => r.message?.role === "assistant" && r.message.content.length);
  assert.deepEqual(row2.message.usage, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 });
  await priced.c.quit();
  await unpriced.c.quit();
});

const REFUSALS = [
  ["a symlink at the path", ({ file, home }) => { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(join(home, "target"), "keep\n"); symlinkSync(join(home, "target"), file); }, /already exists/i],
  ["a path that does not end in the session id", null, /session id/i, { ULTRATERM_UI_TRANSCRIPT_FILE: "/tmp/other-name.jsonl" }],
  ["a relative path", null, /absolute/i, { ULTRATERM_UI_TRANSCRIPT_FILE: "ui-transcripts/x.jsonl" }],
  ["a group-writable folder", ({ dir }) => { mkdirSync(dir, { recursive: true }); chmodSync(dir, 0o770); }, /writable/i],
  ["a path that is a directory", ({ file }) => { mkdirSync(file, { recursive: true, mode: 0o700 }); }, /already exists/i],
];
for (const [name, prepare, pattern, env] of REFUSALS) {
  test(`${name} publishes nothing and shows one notice`, async () => {
    let id;
    const t = rig({ onPrompt: SHORT_TURN }, { prepare: (p) => { id = p.id; prepare?.(p); }, env: env && { ...env, ULTRATERM_UI_TRANSCRIPT_FILE: env.ULTRATERM_UI_TRANSCRIPT_FILE.replace("x.jsonl", `${id}.jsonl`) } });
    await t.c.start();
    await t.turn("hi");
    await t.turn("again");
    await t.c.quit();
    assert.equal(t.notices().length, 1, "exactly one notice");
    assert.match(t.notices()[0].text, pattern);
    if (name === "a symlink at the path") {
      assert.equal(readFileSync(join(t.home, "target"), "utf8"), "keep\n", "the symlink target is untouched");
      assert.ok(lstatSync(t.file).isSymbolicLink());
    } else if (name === "a path that is a directory") {
      assert.deepEqual(readdirSync(t.file), []);
    } else if (name === "a group-writable folder") {
      assert.deepEqual(readdirSync(t.dir), []);
    } else {
      assert.ok(!existsSync(t.file));
    }
    assert.ok(t.c.state.blocks.some((b) => b.kind === "assistant"), "the turn itself still ran");
  });
}

test("a write error mid-session stops publishing with one notice and the turn is not lost", { skip: isRoot && "root ignores file modes" }, async () => {
  const t = rig({ onPrompt: SHORT_TURN });
  await t.c.start();
  await t.turn("first");
  const size = readFileSync(t.file, "utf8");
  chmodSync(t.file, 0o400);
  await t.turn("second");
  await t.turn("third");
  await t.c.quit();
  assert.equal(readFileSync(t.file, "utf8"), size, "nothing more was written");
  assert.equal(t.notices().length, 1);
  assert.match(t.notices()[0].text, /stopped.*EACCES/i);
  assert.equal(t.c.state.blocks.filter((b) => b.kind === "assistant").length, 3, "every turn was shown");
});

test("/new replaces the file atomically with a fresh header; /help and /exit are not published", async () => {
  const t = rig({ onPrompt: SHORT_TURN });
  await t.c.start();
  await t.turn("first");
  const before = statSync(t.file);
  assert.ok(t.rows().length > 3);
  await t.c.submit("/help");
  assert.equal((await t.c.submit("/exit")).quit, true);
  assert.equal(statSync(t.file).ino, before.ino, "local commands touch nothing");
  assert.equal(statSync(t.file).size, before.size);
  await t.c.submit("/new");
  const after = statSync(t.file);
  assert.notEqual(after.ino, before.ino, "a new file replaced the old one");
  assert.deepEqual(t.rows(), [{ type: "session", version: 3, id: t.id, cwd: t.cwd }], "only a header until the next message");
  assert.equal(after.mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(t.dir), [`${t.id}.jsonl`]);
  await t.turn("after new");
  const rows = t.rows();
  assert.equal(rows[1].parentId, null, "the first row of the new file has no parent");
  assert.equal(rows[1].message.content[0].text, "after new");
  await t.c.quit();
});

test("/resume starts a fresh file whose first row says earlier messages are not replayed", async () => {
  const t = rig({ onPrompt: SHORT_TURN });
  await t.c.start();
  await t.turn("first");
  const ino = statSync(t.file).ino;
  await t.c.submit("/resume 0f0f0f0f-0000-4000-8000-000000000009");
  assert.notEqual(statSync(t.file).ino, ino);
  const rows = t.rows();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].parentId, null);
  assert.equal(rows[1].message.role, "assistant");
  assert.match(rows[1].message.content[0].text, /resumed session 0f0f0f0f.*not replayed/);
  assert.equal(rows[1].message.stopReason, "stop");
  await t.c.quit();
});

test("a slash command sent to the harness is a user row and its turn is closed by the query result", async () => {
  const t = rig({ onQuery: [{ notify: { method: "session.query.completed", params: { sessionId: "$SESSION", finalResponse: "Compacted." } } }] });
  await t.c.start();
  await t.c.submit("/compact");
  await until(() => t.rows().length >= 4, "command rows");
  const rows = t.rows().slice(1);
  assert.equal(rows[0].message.role, "user");
  assert.equal(rows[0].message.content[0].text, "/compact");
  assert.equal(rows[1].message.content[0].text, "Compacted.");
  assert.equal(rows[2].message.stopReason, "stop");
  await t.c.quit();
});

test("a failed turn ends with stopReason error and its message; a cancelled one with aborted", async () => {
  const t = rig({ onPrompt: [status("running"), ev({ type: "turn/start", turn: 1 }), call(1, 1, "c9", "bash", { command: "sleep 1" }), ev({ type: "turn/end", turn: 1, reason: { kind: "error", error: { message: "provider returned 429", code: "RATE_LIMIT" } } }), status("idle")] });
  await t.c.start();
  await t.c.submit("go");
  await until(() => t.rows().some((r) => r.message?.stopReason), "stop row");
  const rows = t.rows().slice(1);
  const result = rows.find((r) => r.message.role === "toolResult");
  assert.equal(result.message.toolCallId, "c9");
  assert.equal(result.message.isError, true, "a call left pending is closed as an error result");
  const stop = rows.at(-1).message;
  assert.equal(stop.stopReason, "error");
  assert.match(stop.errorMessage, /429/);
  await t.c.quit();
});

test("with the variables unset nothing is written anywhere", async () => {
  const home = mkdtempSync(join(tmpdir(), "steak-dsh-none-"));
  assert.equal(transcriptFromEnv({}, { cwd: home }), undefined);
  assert.equal(transcriptFromEnv({ ULTRATERM_UI_TRANSCRIPT_FILE: "", ULTRATERM_UI_SESSION_ID: "" }, { cwd: home }), undefined);
  // A real publisher path: the rig's transcript path exists nowhere, the variables are unset, and a controller is
  // built exactly as the TUI builds it (publisher from the environment). Nothing may be created under the home.
  const t = rig({ onPrompt: SHORT_TURN }, { publish: false });
  const publisher = transcriptFromEnv({ PATH: process.env.PATH }, { cwd: t.cwd });
  assert.equal(publisher, undefined);
  const fake = makeFakeDsh({ onPrompt: SHORT_TURN });
  const c = new Controller({ bin: fake.bin, args: ["--profile", "sdk"], options: OPTIONS, cwd: t.cwd, env: fake.env, publisher });
  await c.start();
  await c.submit("hi");
  await until(() => c.state.phase === "complete", "turn");
  await c.quit();
  assert.deepEqual(readdirSync(t.home).sort(), [".ultraterm", "work"]);
  assert.deepEqual(readdirSync(join(t.home, ".ultraterm")), [], "nothing was created in the transcript folder's parent");
  assert.deepEqual(readdirSync(t.cwd), []);
  assert.equal(t.notices().length, 0);
});

test("only one of the two variables set: nothing published and one notice", async () => {
  const t = rig({ onPrompt: SHORT_TURN }, { env: { ULTRATERM_UI_SESSION_ID: "" } });
  await t.c.start();
  await t.turn("hi");
  await t.c.quit();
  assert.equal(t.notices().length, 1);
  assert.ok(!existsSync(t.file));
});

const withHome = (name) => mkdtempSync(join(tmpdir(), `steak-dsh-${name}-`));
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

test("D1: a second publisher on the same path refuses and leaves the first file's bytes unchanged", async () => {
  const t = rig({ onPrompt: SHORT_TURN });
  await t.c.start();
  await t.turn("hi");
  const before = readFileSync(t.file);
  const ino = statSync(t.file).ino;
  const notes = [];
  const second = transcriptFromEnv({ ULTRATERM_UI_TRANSCRIPT_FILE: t.file, ULTRATERM_UI_SESSION_ID: t.id }, { cwd: t.cwd });
  assert.equal(second.start((x) => notes.push(x)), false);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /already exists/);
  second.observe({ type: "submit", text: "x" }, {}, {});
  assert.deepEqual(readFileSync(t.file), before);
  assert.equal(statSync(t.file).ino, ino);
  assert.deepEqual(readdirSync(t.dir), [`${t.id}.jsonl`]);
  await t.c.quit();
});

test("D1: launchEnv removes the three host variables; the child the TUI spawns never sees them", async () => {
  const declared = { ULTRATERM_UI_TRANSCRIPT_FILE: "/x/y.jsonl", ULTRATERM_UI_SESSION_ID: "id", ULTRATERM_MAIN_SCREEN: "1", KEEP: "1" };
  const env = launchEnv(declared);
  for (const name of Object.keys(declared).filter((k) => k.startsWith("ULTRATERM_") && k !== "ULTRATERM_PROVIDER_ACCOUNT")) assert.ok(!(name in env), `${name} is stripped`);
  assert.equal(env.KEEP, "1");
  const home = withHome("child");
  mkdirSync(join(home, ".ultraterm"), { mode: 0o700 });
  const id = randomUUID();
  const file = join(home, ".ultraterm", "ui-transcripts", `${id}.jsonl`);
  const fake = makeFakeDsh({ onPrompt: [status("running"), ev({ type: "turn/start", turn: 1 }), { hang: true }] });
  const hostEnv = { ...fake.env, NO_COLOR: "1", ULTRATERM_UI_TRANSCRIPT_FILE: file, ULTRATERM_UI_SESSION_ID: id, ULTRATERM_MAIN_SCREEN: "1" };
  const stdin = Readable.from([]);
  const out = new Writable({ write(_c, _e, cb) { cb(); } });
  await tuiCommand({ ...OPTIONS, stock: true }, { root: join(here, ".."), bin: fake.bin, stdin, stdout: out, env: hostEnv });
  assert.ok(existsSync(file), "the publisher itself did get the variables");
  const starts = fake.starts();
  assert.ok(starts.length >= 1);
  for (const s of starts) assert.deepEqual(s.hostEnv, [], "the child has none of the three host variables");
});

test("D1: a nested steak-dsh tui on a pipe inside a declared pane publishes nothing and leaves the file alone", async () => {
  const t = rig({ onPrompt: SHORT_TURN });
  await t.c.start();
  await t.turn("hi");
  const before = readFileSync(t.file);
  // The environment a tool run by the agent would inherit is the child's: launchEnv of the declared one.
  const nestedEnv = launchEnv({ ...t.fake.env, NO_COLOR: "1", ULTRATERM_UI_TRANSCRIPT_FILE: t.file, ULTRATERM_UI_SESSION_ID: t.id, ULTRATERM_MAIN_SCREEN: "1" });
  const fake2 = makeFakeDsh({ onPrompt: SHORT_TURN });
  const stdin = Readable.from(["task\n"]);
  const out = new Writable({ write(_c, _e, cb) { cb(); } });
  await tuiCommand({ ...OPTIONS, stock: true }, { root: join(here, ".."), bin: fake2.bin, stdin, stdout: out, env: { ...nestedEnv, FAKE_DSH_SCENARIO: fake2.scenarioPath, FAKE_DSH_LOG: fake2.logPath } });
  assert.deepEqual(readFileSync(t.file), before, "the outer transcript is untouched");
  assert.deepEqual(readdirSync(t.dir), [`${t.id}.jsonl`]);
  await t.c.quit();
});

test("D2: refusals - non-canonical or uppercase uuid, other names, a missing parent, a recursive folder, an unsafe parent", () => {
  const home = withHome("d2");
  const notice = (file, id) => { const out = []; const p = transcriptFromEnv({ ULTRATERM_UI_TRANSCRIPT_FILE: file, ULTRATERM_UI_SESSION_ID: id }, { cwd: home }); const ok = p.start((x) => out.push(x)); return { ok, out }; };
  const id = randomUUID();
  mkdirSync(join(home, "base"), { mode: 0o700 });
  for (const bad of ["abc", id.toUpperCase(), `${id}x`, "../etc", `${id.slice(0, 8)}${id.slice(8).replace(/-/g, "")}`]) {
    const r = notice(join(home, "base", `${bad}.jsonl`), bad);
    assert.equal(r.ok, false, bad);
    assert.equal(r.out.length, 1);
  }
  assert.match(notice(join(home, "base", `${id}.jsonl.bak`), id).out[0], /session id/);
  assert.match(notice(join(home, "no", "such", "ui", `${id}.jsonl`), id).out[0], /parent .*does not exist/);
  assert.ok(!existsSync(join(home, "no")), "no recursive folder creation");
  chmodSync(join(home, "base"), 0o770);
  assert.match(notice(join(home, "base", "sub", `${id}.jsonl`), id).out[0], /parent.*writable/);
  assert.ok(!existsSync(join(home, "base", "sub")));
  chmodSync(join(home, "base"), 0o700);
  const ok = notice(join(home, "base", "sub", `${id}.jsonl`), id);
  assert.equal(ok.ok, true, "a single new folder under a good parent is created");
  assert.equal(statSync(join(home, "base", "sub")).mode & 0o777, 0o700);
});

test("D2: an existing session file of someone else is never replaced at start", () => {
  const home = withHome("d2b");
  const id = randomUUID();
  mkdirSync(join(home, "pi"), { mode: 0o700 });
  const file = join(home, "pi", `${id}.jsonl`);
  writeFileSync(file, "precious\n");
  const p = transcriptFromEnv({ ULTRATERM_UI_TRANSCRIPT_FILE: file, ULTRATERM_UI_SESSION_ID: id }, { cwd: home });
  assert.equal(p.start(() => {}), false);
  assert.equal(readFileSync(file, "utf8"), "precious\n");
});

test("D3: the replace temp file has a random name, is removed on failure, and a foreign temp file is never touched", async () => {
  const t = rig({ onPrompt: SHORT_TURN });
  await t.c.start();
  const p = t.c.publisher;
  const seen = [];
  // A failed replace (the target is turned into a non-empty directory so rename fails) leaves no temp file.
  const before = readFileSync(t.file);
  p.file = join(t.dir, `${t.id}.jsonl`);
  rmSync(t.file);
  mkdirSync(t.file);
  writeFileSync(join(t.file, "keep"), "x");
  assert.throws(() => p.replace());
  assert.deepEqual(readdirSync(t.dir), [`${t.id}.jsonl`], "no temp file left");
  rmSync(t.file, { recursive: true });
  writeFileSync(t.file, before);
  // A foreign file at the old pid-based name is not touched.
  const old = `${t.file}.${process.pid}.tmp`;
  writeFileSync(old, "foreign");
  p.replace();
  assert.equal(readFileSync(old, "utf8"), "foreign");
  for (const name of readdirSync(t.dir)) seen.push(name);
  assert.deepEqual(seen.sort(), [`${t.id}.jsonl`, `${t.id}.jsonl.${process.pid}.tmp`].sort());
  // The temp name collides with a file this process did not create: replace fails and leaves that file alone.
  p.tmpSuffix = () => "collide";
  const collide = `${t.file}.collide.tmp`;
  writeFileSync(collide, "foreign temp");
  assert.throws(() => p.replace(), (e) => e.code === "EEXIST");
  assert.equal(readFileSync(collide, "utf8"), "foreign temp", "a temp file this process did not create is not removed");
  await t.c.quit();
});

test("D4: a deleted file stops publishing, is not recreated, and shows one notice", async () => {
  const t = rig({ onPrompt: SHORT_TURN });
  await t.c.start();
  await t.turn("first");
  rmSync(t.file);
  await t.turn("second");
  await t.turn("third");
  assert.ok(!existsSync(t.file), "not recreated");
  assert.equal(t.notices().length, 1);
  assert.equal(t.c.state.blocks.filter((b) => b.kind === "assistant").length, 3);
  await t.c.quit();
});

test("D4: a file replaced by something else is never appended to, even by the final row", async () => {
  const t = rig({ onPrompt: SHORT_TURN });
  await t.c.start();
  await t.turn("first");
  rmSync(t.file);
  writeFileSync(t.file, "foreign line\n");
  await t.turn("second");
  await t.turn("third");
  assert.equal(readFileSync(t.file, "utf8"), "foreign line\n");
  assert.equal(t.notices().length, 1);
  await t.c.quit();
});

test("D4: on a write error one final row says publishing stopped (no path, no user text); a later /new resumes", { skip: isRoot && "root ignores file modes" }, async () => {
  const t = rig({ onPrompt: SHORT_TURN });
  await t.c.start();
  await t.turn("first");
  const good = t.rows().length;
  // Make the row write fail but the final row succeed: the first append of the next message throws once.
  const publisher = t.c.publisher;
  const realAppend = publisher.append.bind(publisher);
  let armed = true;
  publisher.append = (entry) => { if (armed) { armed = false; const e = new Error("disk full"); e.code = "ENOSPC"; throw e; } return realAppend(entry); };
  await t.turn("second secret text");
  const rows = t.rows();
  assert.equal(rows.length, good + 1, "exactly one final row");
  const last = rows.at(-1);
  assert.equal(last.message.role, "assistant");
  assert.equal(last.message.stopReason, "error");
  assert.equal(last.message.content.length, 1);
  assert.equal(last.message.content[0].type, "text");
  const raw = JSON.stringify(last);
  assert.ok(!raw.includes(t.home) && !raw.includes("secret"), "no path and no user text");
  assert.equal(last.parentId, rows.at(-2).id);
  await t.turn("third");
  assert.equal(t.rows().length, good + 1, "nothing more while stopped");
  assert.equal(t.notices().length, 1);
  await t.c.submit("/new");
  assert.deepEqual(t.rows(), [{ type: "session", version: 3, id: t.id, cwd: t.cwd }], "a fresh replace worked");
  await t.turn("after new");
  assert.equal(t.rows().length, 4);
  assert.equal(t.rows()[1].message.content[0].text, "after new");
  await t.c.quit();
});

test("D5: every published text field is cut at 262144 characters with the suffix; exactly at the limit is kept", async () => {
  const big = (n) => "a".repeat(n);
  const turn = [status("running"), ev({ type: "turn/start", turn: 1 }),
    ev({ type: "assistant/message", turn: 1, step: 1, stream: [], message: textMsg(big(MAX_TEXT + 1)) }),
    call(1, 1, "w1", "write", { file_path: "a.txt", content: big(MAX_TEXT + 5), note: big(MAX_TEXT) }),
    ev({ type: "tool/result", turn: 1, step: 1, message: toolResult("w1", big(MAX_TEXT + 10)) }),
    ev({ type: "turn/end", turn: 1, reason: { kind: "completed" } }), status("idle")];
  const t = rig({ onPrompt: turn });
  await t.c.start();
  await t.turn(big(MAX_TEXT + 2));
  await t.c.quit();
  const rows = t.rows().slice(1);
  const SUFFIX = "\n[truncated]";
  assert.equal(rows[0].message.content[0].text, big(MAX_TEXT) + SUFFIX, "user text");
  assert.equal(rows[1].message.content[0].text, big(MAX_TEXT) + SUFFIX, "assistant text");
  const args = rows[2].message.content[0].arguments;
  assert.equal(args.content, big(MAX_TEXT) + SUFFIX, "tool argument");
  assert.equal(args.note, big(MAX_TEXT), "exactly at the limit is untouched");
  assert.equal(rows[3].message.content[0].text, big(MAX_TEXT) + SUFFIX, "tool result");
  for (const r of rows) assert.ok(JSON.stringify(r).length < 4 * MAX_TEXT);
});

test("M1: a tool call with file_path also carries path with the same value; other arguments are unchanged", async () => {
  const t = rig({ onPrompt: FULL_TURN });
  await t.c.start();
  await t.turn("go");
  await t.c.quit();
  const calls = t.rows().filter((r) => r.message?.content?.[0]?.type === "toolCall").map((r) => r.message.content[0]);
  assert.deepEqual(calls[0].arguments, { file_path: "src/pane.js", path: "src/pane.js" });
  assert.equal(calls[1].arguments.path, "src/pane.js");
  assert.equal(calls[1].arguments.old_string, "const gap = 1;");
  assert.deepEqual(calls[2].arguments, { command: "npm test -- --grep pane" }, "no file_path, no path");
});

test("M2: a cancelled turn ends with aborted and an errored one with error", async () => {
  const hang = [status("running"), ev({ type: "turn/start", turn: 1 }), call(1, 1, "c1", "bash", { command: "sleep 99" }), { hang: true }];
  const t = rig({ onPrompt: hang });
  await t.c.start();
  await t.c.submit("long");
  await until(() => t.c.state.phase === "tool", "tool running");
  assert.equal(await t.c.cancel(), true);
  const stop = t.rows().at(-1);
  assert.equal(stop.message.stopReason, "aborted");
  assert.equal(t.rows().filter((r) => r.message?.role === "toolResult" && r.message.isError).length, 1);
  await t.c.quit();
});

test("M2: only the three stop reasons stop, error and aborted are ever published", async () => {
  const t = rig({ onPrompt: FULL_TURN });
  await t.c.start();
  await t.turn("go");
  await t.c.quit();
  for (const r of t.rows().slice(1)) if (r.message.stopReason !== undefined) assert.ok(["stop", "error", "aborted"].includes(r.message.stopReason));
});

// Round 2 review (2026-11-13).
test("N1: a publisher whose start was refused never replaces the file on /new", async () => {
  const t = rig({ onPrompt: SHORT_TURN });
  await t.c.start();
  await t.turn("hi");
  const before = readFileSync(t.file);
  const ino = statSync(t.file).ino;
  const second = transcriptFromEnv({ ULTRATERM_UI_TRANSCRIPT_FILE: t.file, ULTRATERM_UI_SESSION_ID: t.id }, { cwd: t.cwd });
  assert.equal(second.start(() => {}), false);
  second.observe({ type: "newSession" }, {}, {});
  second.restart();
  assert.deepEqual(readFileSync(t.file), before);
  assert.equal(statSync(t.file).ino, ino);
  assert.deepEqual(readdirSync(t.dir), [`${t.id}.jsonl`]);
  assert.equal(second.active, false);
  await t.c.quit();
  // Someone else's file named by the variables: refused at start and still untouched after /new.
  const home = mkdtempSync(join(tmpdir(), "steak-dsh-n1-"));
  const id = randomUUID();
  const file = join(home, `${id}.jsonl`);
  writeFileSync(file, "precious\n");
  const p = transcriptFromEnv({ ULTRATERM_UI_TRANSCRIPT_FILE: file, ULTRATERM_UI_SESSION_ID: id }, { cwd: home });
  assert.equal(p.start(() => {}), false);
  p.observe({ type: "newSession" }, {}, {});
  assert.equal(readFileSync(file, "utf8"), "precious\n");
  rmSync(home, { recursive: true });
});

test("N1: /new does not replace a foreign file that took the transcript's place", async () => {
  const t = rig({ onPrompt: SHORT_TURN });
  await t.c.start();
  await t.turn("first");
  rmSync(t.file);
  writeFileSync(t.file, "foreign line\n");
  await t.turn("second");
  await t.c.submit("/new");
  await t.turn("third");
  assert.equal(readFileSync(t.file, "utf8"), "foreign line\n");
  assert.deepEqual(readdirSync(t.dir), [`${t.id}.jsonl`]);
  await t.c.quit();
});

test("N2: a write that stops part-way leaves no partial line; every line still parses", async () => {
  const t = rig({ onPrompt: SHORT_TURN });
  await t.c.start();
  await t.turn("first");
  const good = t.rows().length;
  const publisher = t.c.publisher;
  let armed = true;
  publisher.write = (fd, bytes, offset, length) => {
    if (!armed) return writeSync(fd, bytes, offset, length);
    armed = false;
    writeSync(fd, bytes, offset, Math.floor(length / 2));
    const e = new Error("disk full"); e.code = "ENOSPC"; throw e;
  };
  await t.turn("second");
  const text = readFileSync(t.file, "utf8");
  assert.ok(text.endsWith("\n"));
  const rows = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(rows.length, good + 1, "the half-written row is gone; one final row follows");
  assert.equal(rows.at(-1).message.stopReason, "error");
  normalise(rows.slice(1));
  // A write that reports fewer bytes without failing is finished by the loop.
  await t.c.submit("/new");
  publisher.write = (fd, bytes, offset, length) => writeSync(fd, bytes, offset, Math.min(length, 7));
  await t.turn("after new");
  assert.equal(t.rows()[1].message.content[0].text, "after new");
  assert.equal(t.rows().length, 4);
  await t.c.quit();
});

test("N3: a failed /new keeps the old file's row ids unique and chained", async () => {
  const t = rig({ onPrompt: SHORT_TURN });
  await t.c.start();
  await t.turn("first");
  const good = t.rows().length;
  const publisher = t.c.publisher;
  publisher.tmpSuffix = () => "collide";
  writeFileSync(`${t.file}.collide.tmp`, "foreign temp");
  await t.c.submit("/new");
  const rows = t.rows();
  assert.equal(rows.length, good + 1);
  assert.equal(rows.at(-1).message.stopReason, "error");
  normalise(rows.slice(1));
  await t.c.quit();
});

test("N4: a cut never splits a character, a lone surrogate is never published, and an oversized row is slimmed", async () => {
  const astral = "a".repeat(MAX_TEXT - 1) + "\u{1F600}" + "tail";
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "b".repeat(MAX_TEXT)]));
  const turn = [status("running"), ev({ type: "turn/start", turn: 1 }),
    ev({ type: "assistant/message", turn: 1, step: 1, stream: [], message: textMsg("lone \ud83d here") }),
    call(1, 1, "w1", "write", { file_path: "a.txt", ...many }),
    ev({ type: "tool/result", turn: 1, step: 1, message: toolResult("w1", "ok") }),
    ev({ type: "turn/end", turn: 1, reason: { kind: "completed" } }), status("idle")];
  const t = rig({ onPrompt: turn });
  await t.c.start();
  await t.turn(astral);
  await t.c.quit();
  const raw = readFileSync(t.file, "utf8");
  assert.ok(!/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(raw), "no lone high surrogate escape in the file");
  const lines = raw.split("\n").filter(Boolean);
  for (const line of lines) assert.ok(Buffer.byteLength(line, "utf8") <= MAX_ROW, "every line is within the row limit");
  const rows = lines.map((line) => JSON.parse(line)).slice(1);
  assert.equal(rows[0].message.content[0].text, "a".repeat(MAX_TEXT - 1) + "\n[truncated]", "cut before the character, not inside it");
  assert.ok(rows[1].message.content[0].text.isWellFormed());
  const toolCall = rows[2].message.content[0];
  assert.equal(toolCall.type, "toolCall");
  assert.equal(toolCall.id, "w1");
  assert.deepEqual(toolCall.arguments, { input: "[truncated]" });
  normalise(rows);
});
