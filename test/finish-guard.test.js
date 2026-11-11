import test from "node:test";
import assert from "node:assert/strict";
import { apply, finishVerdict, openTodos, openWorkPhrases, readTurn, MARK } from "../plugins/finish-guard.js";

const session = (events) => ({ seq: events.length, eventAt: (i) => events[i] });
const user = (text) => ({ type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text }] } });
const reply = (text) => ({ type: "assistant/message", data: { message: { content: [{ type: "text", text }] } } });
const todos = (list) => ({ type: "todo/write", data: { todos: list } });

test("open todos keep the turn open, finished ones do not", () => {
  assert.equal(openTodos([{ content: "a", status: "completed" }, { content: "b", status: "pending" }]).length, 1);
  assert.equal(openTodos([{ content: "a", status: "blocked", reason: "needs the 2FA code" }]).length, 0);
  assert.equal(openTodos([{ content: "a", status: "blocked", reason: "it was hard" }]).length, 1);
});

test("unfinished-work wording is found, quoted wording and plain reports are not", () => {
  assert.deepEqual(openWorkPhrases("Remaining items: the parser"), ["Remaining items:"]);
  assert.equal(openWorkPhrases("The log said `still failing` earlier; all fixed and tests pass.").length, 0);
  assert.equal(openWorkPhrases("Renamed it. I did not run anything, as you asked.").length, 0);
  assert.equal(openWorkPhrases("Done. Tests pass.").length, 0);
});

test("verdict: blocks on open work, respects stop requests and the push cap", () => {
  const base = { todos: [{ content: "b", status: "pending" }], finalText: "ok", userText: "do a and b", pushes: 0 };
  const v = finishVerdict(base);
  assert.equal(v.block, true);
  assert.match(v.reason, new RegExp(`^${MARK}`));
  assert.match(v.reason, /\[pending\] b/);
  assert.equal(finishVerdict({ ...base, pushes: 3 }).block, false);
  assert.equal(finishVerdict({ ...base, userText: "stop, don't change anything" }).block, false);
  assert.equal(finishVerdict({ ...base, todos: [] }).block, false);
});

test("readTurn takes the newest reply, request and todo list", () => {
  const s = session([
    { type: "turn/start", data: { turn: 1 } }, user("first"), todos([{ content: "x", status: "pending" }]), reply("old"),
    todos([{ content: "x", status: "completed" }]), reply("new"),
  ]);
  const facts = readTurn(s, 1);
  assert.equal(facts.finalText, "new");
  assert.equal(facts.userText, "first");
  assert.equal(facts.todos[0].status, "completed");
});

const harness = (config) => {
  const handlers = {};
  apply({ on: (name, fn) => { handlers[name] = fn; }, logger: { warn() {} } }, config);
  return handlers["agent/turn-stopping"];
};

test("plugin steers once per push and stops at the cap", () => {
  const stopping = harness({ maxPushes: 2 });
  const steered = [];
  const agent = { session: session([{ type: "turn/start", data: { turn: 1 } }, user("do it"), reply("Remaining items: b")]), steer: (m) => steered.push(m) };
  const signal = { aborted: false };
  stopping({ agent, turn: 1, signal });
  stopping({ agent, turn: 1, signal });
  stopping({ agent, turn: 1, signal });
  assert.equal(steered.length, 2);
  assert.equal(steered[0].role, "user");
  assert.equal(steered[0].source.kind, "steak-finish-guard");
  assert.ok(Object.isFrozen(steered[0]));
  stopping({ agent, turn: 2, signal });
  assert.equal(steered.length, 3, "a new turn gets its own pushes");
});

test("plugin does nothing when finished, aborted or disabled", () => {
  const steered = [];
  const done = { session: session([user("do it"), reply("Done, tests pass.")]), steer: (m) => steered.push(m) };
  harness({})({ agent: done, turn: 1, signal: { aborted: false } });
  const open = { session: session([user("do it"), reply("Remaining items: b")]), steer: (m) => steered.push(m) };
  harness({})({ agent: open, turn: 1, signal: { aborted: true } });
  assert.equal(steered.length, 0);
  assert.equal(harness({ enabled: false }), undefined);
});
