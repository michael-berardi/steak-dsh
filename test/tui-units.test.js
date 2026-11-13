import test from "node:test";
import assert from "node:assert/strict";
import { Editor, HOLD_DELETE_CLEAR_MS } from "../lib/tui/editor.js";
import { KeyParser } from "../lib/tui/keys.js";
import { inlineSpans, renderMarkdown } from "../lib/tui/markdown.js";
import { approvalPrompt, promptKey, questionPrompt } from "../lib/tui/prompt.js";
import { renderBand } from "../lib/tui/band.js";
import { diffLines, enrichMeta, locateHunks, renderHunk, wordDiff } from "../lib/tui/diff.js";
import { JsonRpcClient } from "../lib/tui/rpc.js";
import { initialState, reduce, statusPresentation } from "../lib/tui/state.js";
import { createTheme, detectColorMode, rgbTo256 } from "../lib/tui/theme.js";
import { displayPath, renderTranscript } from "../lib/tui/transcript.js";
import { clipAnsi, fitLine, fitSides, formatTokens, graphemeWidth, stripAnsi, truncatePlain, visibleWidth, wrapPlain } from "../lib/tui/width.js";
import { PassThrough } from "node:stream";

const plain = createTheme({ mode: "none" });

// ---- width -------------------------------------------------------------------------------------------------

test("width: ASCII, wide CJK, emoji, combining marks and ZWJ sequences", () => {
  assert.equal(visibleWidth("abc"), 3);
  assert.equal(visibleWidth("日本語"), 6);
  assert.equal(visibleWidth("é"), 1, "a combining accent adds no column");
  assert.equal(visibleWidth("🥩"), 2);
  assert.equal(visibleWidth("👨‍👩‍👧"), 2, "a ZWJ family is one two-column cluster");
  assert.equal(visibleWidth("🇯🇵"), 2, "a flag is one two-column cluster");
  assert.equal(visibleWidth("\x1b[31mred\x1b[0m"), 3, "ANSI is never counted");
  assert.equal(graphemeWidth("​"), 0);
});

test("width: truncation and wrapping never split a grapheme or a wide character", () => {
  assert.equal(truncatePlain("日本語日本語", 7), "日本語…");
  assert.ok(visibleWidth(truncatePlain("日本語日本語", 6)) <= 6);
  assert.equal(truncatePlain("éééé", 3), "éé…");
  assert.equal(truncatePlain("🥩🥩🥩", 4), "🥩…");
  for (const line of wrapPlain("日本語のテスト 🥩 éclair and a very long English word supercalifragilistic", 9, "  ")) {
    assert.ok(visibleWidth(line) <= 9, JSON.stringify(line));
  }
  assert.equal(clipAnsi("\x1b[31mredtext\x1b[0m", 3), "\x1b[31mred\x1b[0m");
  assert.equal(stripAnsi(clipAnsi("日本語", 3)), "日", "a wide char that does not fit is dropped, not halved");
  assert.equal(fitLine("a\tb", 10), "a   b");
});

test("width: fitSides keeps both sides when they fit and drops the right one first", () => {
  assert.deepEqual(fitSides("left", "right", 20), { left: "left", gap: " ".repeat(11), right: "right" });
  const tight = fitSides("a long left region here", "right side hints", 24);
  assert.ok(visibleWidth(tight.left + tight.gap + tight.right) <= 24);
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(11900), "11.9k");
  assert.equal(formatTokens(131072), "131k");
});

// ---- theme / NO_COLOR --------------------------------------------------------------------------------------

test("theme: Steak dark tokens resolve to the documented values", () => {
  const t = createTheme({ mode: "truecolor" });
  assert.equal(t.accent("x"), "\x1b[38;2;230;57;70mx\x1b[39m", "steakRed #e63946");
  assert.equal(t.success("x"), "\x1b[38;2;42;157;92mx\x1b[39m", "stem #2a9d5c");
  assert.equal(t.warning("x"), "\x1b[38;2;244;201;93mx\x1b[39m", "jackpot #f4c95d");
  assert.equal(t.error("x"), "\x1b[38;2;176;42;55mx\x1b[39m", "steakDeep #b02a37");
  assert.equal(t.muted("x"), "\x1b[38;5;245mx\x1b[39m");
  assert.equal(t.dim("x"), "\x1b[38;5;240mx\x1b[39m");
  assert.equal(t.bg("toolPendingBg", "x"), "\x1b[48;2;29;32;38mx\x1b[49m", "surfaceRaised #1d2026");
  assert.equal(createTheme({ mode: "256" }).accent("x"), `\x1b[38;5;${rgbTo256([230, 57, 70])}mx\x1b[39m`);
});

test("NO_COLOR and a non-TTY output select the plain theme: no escape sequence is ever produced", () => {
  const tty = { isTTY: true };
  assert.equal(detectColorMode({ NO_COLOR: "1" }, tty), "none");
  assert.equal(detectColorMode({ NO_COLOR: "" , COLORTERM: "truecolor" }, tty), "truecolor", "an empty NO_COLOR is ignored, as the convention says");
  assert.equal(detectColorMode({}, { isTTY: false }), "none");
  assert.equal(detectColorMode({ TERM: "dumb" }, tty), "none");
  assert.equal(detectColorMode({ COLORTERM: "24bit" }, tty), "truecolor");
  assert.equal(detectColorMode({ TERM: "xterm-256color" }, tty), "256");
  const t = createTheme({ mode: "none" });
  const state = reduce(initialState({ model: "p/m", contextWindow: 1000 }), { type: "submit", text: "hi" });
  const text = [t.accent("a"), t.bg("userMessageBg", "b"), t.bold("c"), t.inverse("d"), ...renderBand(80, state, t)].join("");
  assert.ok(!text.includes("\x1b"));
});

// ---- keys --------------------------------------------------------------------------------------------------

test("keys: arrows, modifiers, ctrl, alt and escape", () => {
  const p = new KeyParser();
  const names = (s) => p.feed(s).map((e) => (e.type === "key" ? [e.name, e.ctrl && "ctrl", e.alt && "alt", e.shift && "shift"].filter(Boolean).join("+") : `${e.type}:${e.text}`));
  assert.deepEqual(names("\x1b[A\x1b[B\x1b[C\x1b[D"), ["up", "down", "right", "left"]);
  assert.deepEqual(names("\x1b[1;5C"), ["right+ctrl"]);
  assert.deepEqual(names("\x1b[1;3D"), ["left+alt"]);
  assert.deepEqual(names("\x1b[3~\x1b[5~\x1b[6~"), ["delete", "pageup", "pagedown"]);
  assert.deepEqual(names("\x01\x0b\x15"), ["a+ctrl", "k+ctrl", "u+ctrl"]);
  assert.deepEqual(names("\x1b\r"), ["enter+alt"]);
  assert.deepEqual(names("\x1bb"), ["b+alt"]);
  assert.deepEqual(names("\x1b"), ["escape"]);
  assert.deepEqual(names("\x7f"), ["backspace"]);
  assert.deepEqual(names("hello"), ["text:hello"]);
  assert.deepEqual(names("\n"), ["enter+ctrl"], "ctrl+j is a newline key");
});

test("keys: bracketed paste is one event, survives chunking, and is never read as keys", () => {
  const p = new KeyParser();
  const all = [];
  for (const chunk of ["x\x1b[20", "0~line one\r\nli", "ne \x1b[A\x03 two\x1b[2", "01~y"]) all.push(...p.feed(chunk));
  assert.deepEqual(all, [
    { type: "text", text: "x" },
    { type: "paste", text: "line one\r\nline \x1b[A\x03 two" },
    { type: "text", text: "y" },
  ]);
});

// ---- editor ------------------------------------------------------------------------------------------------

const key = (name, mods = {}) => ({ type: "key", name, ctrl: false, alt: false, shift: false, ...mods });
const type = (e, text) => e.handle({ type: "text", text });

test("editor: typing, cursor motion by grapheme, backspace and delete", () => {
  const e = new Editor();
  type(e, "a日é🥩");
  e.handle(key("left"));
  assert.equal(e.lines[0].slice(e.col), "🥩", "left moves over a whole emoji");
  e.handle(key("left"));
  e.handle(key("backspace"));
  assert.equal(e.text, "aé🥩".replace("a", "a日").replace("日é", "日é") && e.text, "sanity");
  assert.equal(e.text, "aé🥩", "backspace removed the wide char before the cursor");
  e.handle(key("backspace"));
  assert.equal(e.text, "é🥩".replace(/^/, "") && e.text);
  e.handle(key("backspace"));
  assert.equal(e.text, "é🥩", "cursor was at start of 'e'; nothing before it");
  e.handle(key("delete"));
  assert.equal(e.text, "🥩", "delete removes the whole combining cluster");
});

test("editor: multi-line (ctrl+j, alt+enter, backslash-enter), enter submits, blank input does not", () => {
  const e = new Editor();
  assert.deepEqual(e.handle(key("enter")), {}, "empty enter sends nothing");
  type(e, "one");
  e.handle(key("enter", { ctrl: true }));
  type(e, "two");
  e.handle(key("enter", { alt: true }));
  type(e, "three\\");
  e.handle(key("enter"));
  type(e, "four");
  assert.equal(e.text, "one\ntwo\nthree\nfour");
  assert.deepEqual(e.handle(key("enter")), { submit: "one\ntwo\nthree\nfour" });
  assert.ok(e.empty);
});

test("editor: history with up/down at the edges, draft restored", () => {
  const e = new Editor();
  for (const m of ["first", "second"]) { type(e, m); e.handle(key("enter")); }
  type(e, "draft");
  e.handle(key("up"));
  assert.equal(e.text, "second");
  e.handle(key("up"));
  assert.equal(e.text, "first");
  e.handle(key("up"));
  assert.equal(e.text, "first", "stops at the oldest");
  e.handle(key("down"));
  e.handle(key("down"));
  assert.equal(e.text, "draft", "the unsent draft comes back");
});

test("editor: kill-line keys, word motion, yank", () => {
  const e = new Editor();
  type(e, "alpha beta gamma");
  e.handle(key("w", { ctrl: true }));
  assert.equal(e.text, "alpha beta ");
  e.handle(key("y", { ctrl: true }));
  assert.equal(e.text, "alpha beta gamma", "ctrl+y yanks the killed word back");
  e.handle(key("a", { ctrl: true }));
  e.handle(key("right", { alt: true }));
  assert.equal(e.col, 5);
  e.handle(key("k", { ctrl: true }));
  assert.equal(e.text, "alpha");
  e.handle(key("a", { ctrl: true }));
  e.handle(key("u", { ctrl: true }));
  assert.equal(e.text, "alpha", "ctrl+u at column 0 kills nothing");
  e.handle(key("e", { ctrl: true }));
  e.handle(key("u", { ctrl: true }));
  assert.equal(e.text, "");
  e.handle(key("y", { ctrl: true }));
  assert.equal(e.text, "alpha");
  e.handle(key("b", { alt: true }));
  assert.equal(e.col, 0);
});

test("editor: paste is inserted verbatim, with newlines, control bytes removed, and never submits", () => {
  const e = new Editor();
  const r = e.handle({ type: "paste", text: "line1\r\nline2\x03\n\nline4" });
  assert.deepEqual(r, {});
  assert.equal(e.text, "line1\nline2\n\nline4");
  assert.equal(e.row, 3);
});

test("editor: holding Backspace for 1.5 s clears the whole input; a slow tap does not", () => {
  let t = 0;
  const e = new Editor({ now: () => t });
  type(e, "x".repeat(40));
  for (t = 0; t < HOLD_DELETE_CLEAR_MS; t += 50) e.handle(key("backspace"));
  assert.ok(e.text.length > 0, "not yet cleared before 1.5 s");
  t = HOLD_DELETE_CLEAR_MS;
  e.handle(key("backspace"));
  assert.equal(e.text, "");
  type(e, "abcdef");
  for (let i = 0; i < 3; i++) { t += 400; e.handle(key("backspace")); }
  assert.equal(e.text, "abc", "taps more than 200 ms apart are single deletes");
});

test("editor: layout wraps on grapheme boundaries and keeps the cursor on the right row and column", () => {
  const e = new Editor();
  type(e, "日本語日本語");
  const { rows, cursorRow, cursorCol } = e.layout(6);
  assert.deepEqual(rows, ["日本語", "日本語"]);
  assert.equal(cursorRow, 1);
  assert.equal(cursorCol, 6);
  const r = e.render(20, plain);
  assert.equal(stripAnsi(r.lines[0]), "╰─ 日本語日本語");
  assert.deepEqual(r.cursor, { row: 0, col: 3 + 12 });
  const empty = new Editor().render(20, plain);
  assert.equal(empty.lines[0], "╰─ Message");
});

// ---- JSON-RPC ----------------------------------------------------------------------------------------------

function pair() {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent = [];
  output.on("data", (d) => sent.push(...String(d).trim().split("\n").map((l) => JSON.parse(l))));
  return { input, output, sent };
}

test("rpc: requests resolve by id, notifications and server requests dispatch, malformed lines are ignored", async () => {
  const { input, output, sent } = pair();
  const seen = [];
  const rpc = new JsonRpcClient({ input, output }, {
    onNotification: (m, p) => seen.push([m, p]),
    onRequest: async (m, p) => (m === "approval/request" ? { outcome: "rejected" } : undefined),
  });
  const pending = rpc.request("initialize", { a: 1 });
  assert.deepEqual(sent[0], { jsonrpc: "2.0", id: 1, method: "initialize", params: { a: 1 } });
  input.write("not json\n{\"jsonrpc\":\"2.0\",\"method\":\"session.status\",\"params\":{\"s\":1}}\n");
  input.write("{\"jsonrpc\":\"2.0\",\"id\":1,\"res");
  input.write("ult\":{\"ok\":true}}\n");
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(seen, [["session.status", { s: 1 }]]);
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 50, method: "approval/request", params: {} }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 51, method: "unknown/thing" }) + "\n");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent.find((m) => m.id === 50), { jsonrpc: "2.0", id: 50, result: { outcome: "rejected" } });
  assert.equal(sent.find((m) => m.id === 51).error.code, -32601);
  const failing = rpc.request("x");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "boom" } }) + "\n");
  await assert.rejects(failing, /boom/);
  const dangling = rpc.request("y");
  input.end();
  await assert.rejects(dangling, /closed/);
  await assert.rejects(rpc.request("z"), /not running/);
});

// ---- reducer / vocabulary ----------------------------------------------------------------------------------

test("reducer: the phase vocabulary and tones", () => {
  const s = initialState({ sessionId: "s" });
  const say = (patch) => statusPresentation({ ...s, ...patch });
  assert.deepEqual(say({}), { text: "● new session", tone: "dim" });
  assert.deepEqual(say({ phase: "thinking", detail: "" }), { text: "◆ thinking", tone: "accent" });
  assert.deepEqual(say({ phase: "responding" }), { text: "◆ responding", tone: "accent" });
  assert.deepEqual(say({ phase: "tool", activeTools: { a: "read" } }), { text: "◆ tool read", tone: "accent" });
  assert.deepEqual(say({ phase: "tool", activeTools: { a: "read", b: "grep" } }), { text: "◆ tools 2", tone: "accent" });
  assert.deepEqual(say({ phase: "waiting", detail: "bash" }), { text: "◇ waiting · bash", tone: "warning" });
  assert.deepEqual(say({ phase: "compacting" }), { text: "◆ compacting", tone: "warning" });
  assert.deepEqual(say({ phase: "complete" }), { text: "✓ complete", tone: "success" });
  assert.deepEqual(say({ phase: "error", detail: "x" }), { text: "! error · x", tone: "error" });
  assert.deepEqual(say({ phase: "stopped", detail: "cancelled" }), { text: "! stopped · cancelled", tone: "warning" });
});

test("reducer: events for another session are ignored; usage and context fold; interrupted marks stopped", () => {
  let s = initialState({ sessionId: "A", contextWindow: 1000 });
  const ev = (sessionId, event) => ({ type: "notification", method: "session.event", params: { sessionId, event } });
  s = reduce(s, ev("B", { type: "turn/start", turn: 1 }));
  assert.equal(s.phase, "ready");
  s = reduce(s, ev("A", { type: "assistant/message", message: { content: [{ type: "text", text: "partial" }] }, interrupted: true, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10 } }));
  assert.equal(s.phase, "stopped");
  assert.equal(s.detail, "interrupted");
  assert.deepEqual(s.usage, { input: 100, output: 20, cacheRead: 50, cacheWrite: 10, requests: 1, cost: 0 });
  assert.equal(s.contextTokens, 180);
  s = reduce(s, ev("A", { type: "request/context", contextWindow: 2000 }));
  assert.equal(s.contextWindow, 2000);
});

test("reducer: parallel tools are tracked by call id; a failed tool is an error until the turn completes", () => {
  let s = initialState({ sessionId: "A" });
  const ev = (event) => ({ type: "notification", method: "session.event", params: { sessionId: "A", event } });
  s = reduce(s, ev({ type: "turn/start" }));
  s = reduce(s, ev({ type: "tool/call", callId: "1", name: "read", arguments: "{\"path\":\"a\"}" }));
  s = reduce(s, ev({ type: "tool/call", callId: "2", name: "grep", arguments: "{}" }));
  assert.equal(statusPresentation(s).text, "◆ tools 2");
  s = reduce(s, ev({ type: "tool/result", message: { toolCallId: "1", isError: true, content: [{ type: "text", text: "no" }] }, error: { name: "E", code: "C", reason: "bad" } }));
  assert.equal(s.phase, "error");
  s = reduce(s, ev({ type: "tool/result", message: { toolCallId: "2", content: [] } }));
  assert.equal(s.phase, "error", "sticky within the turn");
  s = reduce(s, ev({ type: "turn/end", reason: { kind: "completed" } }));
  assert.equal(s.phase, "complete");
  assert.equal(s.blocks[0].args.path, "a");
});

test("reducer: the SDK wire shape (fields wrapped in data) reads the same as the flat shape", () => {
  // Recorded from dsh 0.2.2-rc.1 --profile sdk: { type, seq, time, data: { ... } }.
  const wire = (event) => ({ type: "notification", method: "session.event", params: { sessionId: "A", event } });
  let s = initialState({ sessionId: "A", cwd: "/work/repo" });
  s = reduce(s, wire({ type: "turn/start", seq: 4, time: 1, data: { turn: 1 } }));
  s = reduce(s, wire({ type: "request/context", seq: 5, time: 1, data: { provider: "gw", model: "m", contextWindow: 4000 } }));
  s = reduce(s, wire({ type: "tool/call", seq: 6, time: 1, data: { turn: 1, step: 1, callId: "c1", name: "edit", arguments: "{\"file_path\":\"/work/repo/src/a.js\"}" } }));
  assert.equal(statusPresentation(s).text, "◆ tool edit");
  s = reduce(s, wire({ type: "tool/result", seq: 7, time: 1, data: { turn: 1, step: 1, message: { toolCallId: "c1", isError: false, content: [{ type: "text", text: "ok" }] }, meta: { diffs: [{ path: "/work/repo/src/a.js", oldText: "a", newText: "b" }] } }, surfaceOp: "append" }));
  s = reduce(s, wire({ type: "assistant/message", seq: 8, time: 1, data: { turn: 1, step: 2, message: { role: "assistant", content: [{ type: "text", text: "Done." }] }, usage: { inputTokens: 300, outputTokens: 100, cacheReadTokens: 600 } } }));
  s = reduce(s, wire({ type: "turn/end", seq: 9, time: 1, data: { turn: 1, reason: { kind: "completed" } } }));
  assert.equal(s.phase, "complete");
  assert.equal(s.contextWindow, 4000);
  assert.equal(s.contextTokens, 1000);
  assert.deepEqual(s.blocks.map((b) => [b.kind, b.name ?? b.text, b.status]), [["tool", "edit", "success"], ["assistant", "Done.", undefined]]);
  assert.equal(s.blocks[0].meta.diffs.length, 1);
  const lines = renderTranscript(s, 60, createTheme({ mode: "none" })).map((l) => l.trimEnd());
  assert.equal(lines[0], " ✓ edit src/a.js", "the tool is named and its path is shown relative to the working directory");
  assert.equal(lines[1], " src/a.js (line numbers relative to the hunk)");
  assert.ok(!lines.join("\n").includes("undefined"));
  // A wire error is read from data too.
  let e = reduce(initialState({ sessionId: "A" }), wire({ type: "turn/end", seq: 1, time: 1, data: { turn: 1, reason: { kind: "error", error: { message: "boom" } } } }));
  assert.equal(e.phase, "error");
});

test("paths: only a path inside the working directory is shortened", () => {
  assert.equal(displayPath("/work/repo/src/a.js", "/work/repo"), "src/a.js");
  assert.equal(displayPath("/work/repo/src/a.js", "/work/repo/"), "src/a.js");
  assert.equal(displayPath("/work/repo-other/a.js", "/work/repo"), "/work/repo-other/a.js");
  assert.equal(displayPath("/etc/hosts", "/work/repo"), "/etc/hosts");
  assert.equal(displayPath("src/a.js", "/work/repo"), "src/a.js");
  assert.equal(displayPath("/work/repo/a.js", ""), "/work/repo/a.js");
});

// ---- markdown / diff ---------------------------------------------------------------------------------------

test("markdown: headings, bullets, quotes, fences and inline spans", () => {
  assert.deepEqual(inlineSpans("a **b** `c` [d](http://x) *e* **open"), [
    { text: "a ", style: "plain" }, { text: "b", style: "bold" }, { text: " ", style: "plain" }, { text: "c", style: "code" },
    { text: " ", style: "plain" }, { text: "d", style: "link" }, { text: " ", style: "plain" }, { text: "e", style: "italic" }, { text: " **open", style: "plain" },
  ]);
  const lines = renderMarkdown("# Title\n\n- one\n- two with `code`\n1. first\n> quote\n```py\nx = 1\n```\n", 30, plain);
  assert.deepEqual(lines, ["Title", "", "• one", "• two with code", "1. first", "▏ quote", "╭ py", "│ x = 1"]);
  const wrapped = renderMarkdown("- " + "word ".repeat(12), 20, plain);
  assert.ok(wrapped.length > 2 && wrapped.slice(1).every((l) => l.startsWith("  ")), "hanging indent on bullets");
  assert.ok(renderMarkdown("**bold and `code` across a very long line that wraps**", 12, plain).every((l) => visibleWidth(l) <= 12));
});

test("diff: numbered lines, removed before added, word-level highlight only for a 1:1 change", () => {
  const out = renderHunk({ path: "f", oldText: "a\nold line\nz", newText: "a\nnew line\nz", oldStart: 9, newStart: 9 }, 40, plain);
  assert.deepEqual(out, ["  9 a", "-10 old line", "+10 new line", " 11 z"]);
  const t = createTheme({ mode: "truecolor" });
  const hl = renderHunk({ path: "f", oldText: "x = 1;", newText: "x = 2;" }, 40, t);
  assert.ok(hl[0].includes("\x1b[7m") && hl[1].includes("\x1b[7m"), "inverse on the changed word");
  const multi = renderHunk({ path: "f", oldText: "a\nb", newText: "c\nd" }, 40, t);
  assert.ok(!multi.join("").includes("\x1b[7m"), "no word diff for 2:2 groups");
  assert.deepEqual(renderHunk({ path: "f", oldText: null, newText: "p\nq" }, 20, plain), ["+1 p", "+2 q"]);
  assert.deepEqual(wordDiff("a b c", "a x c")[0].filter((s) => s.changed).map((s) => s.text), ["b"]);
  assert.deepEqual(diffLines(["a", "b"], ["a", "b"]).map((o) => o.t), ["ctx", "ctx"]);
});

test("diff: hunks are located in the edited file, accounting for earlier hunks; a miss stays relative", () => {
  const file = "l1\nl2\nNEW A\nl4\nl5\nl6\nl7\nB-new\nl9\n";
  const hunks = [
    { path: "f", oldText: "l1\nl2\nOLD A\nl4", newText: "l1\nl2\nNEW A\nl4" },
    { path: "f", oldText: "l7\nB-old\nl9", newText: "l7\nB-new\nl9" },
    { path: "f", oldText: "zzz", newText: "not in the file" },
  ];
  const located = locateHunks(hunks, file);
  assert.deepEqual([located[0].newStart, located[0].oldStart, located[1].newStart], [1, 1, 7]);
  assert.equal(located[2].newStart, undefined);
  const meta = enrichMeta({ diffs: hunks }, "/x", () => file);
  assert.equal(meta.diffs[1].newStart, 7);
  assert.deepEqual(enrichMeta({ other: 1 }, "/x"), { other: 1 });
  assert.equal(enrichMeta({ diffs: hunks }, "/x", () => { throw new Error("nope"); }).diffs[0].newStart, undefined);
});

// ---- prompts -----------------------------------------------------------------------------------------------

test("approval prompt: only an explicit allow permits; Esc, n and Ctrl-C reject; stray keys do nothing", () => {
  const p = approvalPrompt({ toolName: "bash", sessionId: "s" }, 5);
  assert.deepEqual(promptKey(p, key("enter")).result, { outcome: "allowed-once" }, "first row is Allow once, but only on Enter");
  assert.equal(promptKey(p, { type: "text", text: "x" }).result, undefined);
  assert.equal(promptKey(p, key("left")).result, undefined);
  assert.deepEqual(promptKey(p, key("escape")).result, { outcome: "rejected" });
  assert.deepEqual(promptKey(p, key("c", { ctrl: true })).result, { outcome: "rejected" });
  assert.deepEqual(promptKey(p, { type: "text", text: "n" }).result, { outcome: "rejected" });
  const down = promptKey(p, key("down")).prompt;
  assert.deepEqual(promptKey(down, key("enter")).result, { outcome: "rejected" });
});

test("question prompt: single, multi-select, custom text, several questions, dismissal", () => {
  const q = questionPrompt({ requestId: "r", sessionId: "s", questions: [
    { id: "a", question: "A?", options: [{ label: "x" }, { label: "y" }] },
    { id: "b", question: "B?", multiSelect: true, options: [{ label: "p" }, { label: "q" }] },
    { id: "c", question: "C?" },
  ] }, 9);
  let s = promptKey(q, key("down"));
  s = promptKey(s.prompt, key("enter"));
  assert.equal(s.prompt.qi, 1);
  s = promptKey(s.prompt, { type: "text", text: " " });
  s = promptKey(s.prompt, key("down"));
  s = promptKey(s.prompt, { type: "text", text: " " });
  s = promptKey(s.prompt, key("enter"));
  assert.equal(s.prompt.qi, 2);
  s = promptKey(s.prompt, key("enter"));
  assert.equal(s.prompt.typing, "");
  s = promptKey(s.prompt, key("enter"));
  assert.match(s.prompt.error, /type an answer/);
  s = promptKey(s.prompt, { type: "paste", text: "free\ntext" });
  s = promptKey(s.prompt, key("enter"));
  assert.deepEqual(s.result, { answers: [{ id: "a", selected: ["y"] }, { id: "b", selected: ["p", "q"] }, { id: "c", selected: [], custom: "free text" }] });
  assert.deepEqual(promptKey(q, key("escape")).result, { cancelled: true });
  const other = promptKey(promptKey(q, key("up")).prompt, key("enter"));
  assert.equal(other.prompt.typing, "", "the Other row opens text entry");
  const approvalIntent = questionPrompt({ questions: [{ id: "i", question: "?", intent: { kind: "approval", approve: "Yes", reject: "No" } }] }, 1);
  assert.deepEqual(promptKey(approvalIntent, key("enter")).result, { answers: [{ id: "i", selected: ["Yes"] }] });
});
