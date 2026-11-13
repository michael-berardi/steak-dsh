import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Controller } from "../lib/tui/session.js";
import { transcriptFromEnv } from "../lib/tui/transcript-publisher.js";
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
  ["a symlink at the path", ({ file, home }) => { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(join(home, "target"), "keep\n"); symlinkSync(join(home, "target"), file); }, /symlink|regular/i],
  ["a path that does not end in the session id", null, /session id/i, { ULTRATERM_UI_TRANSCRIPT_FILE: "/tmp/other-name.jsonl" }],
  ["a relative path", null, /absolute/i, { ULTRATERM_UI_TRANSCRIPT_FILE: "ui-transcripts/x.jsonl" }],
  ["a group-writable folder", ({ dir }) => { mkdirSync(dir, { recursive: true }); chmodSync(dir, 0o770); }, /writable/i],
  ["a path that is a directory", ({ file }) => { mkdirSync(file, { recursive: true, mode: 0o700 }); }, /regular/i],
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
  const t = rig({ onPrompt: SHORT_TURN }, { publish: false });
  await t.c.start();
  await t.turn("hi");
  await t.c.quit();
  assert.deepEqual(readdirSync(t.home), ["work"], "no .ultraterm folder appeared");
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
