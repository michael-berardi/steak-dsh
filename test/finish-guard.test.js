import test from "node:test";
import assert from "node:assert/strict";
import { apply, finishVerdict, isSubagent, openTodos, openWorkPhrases, readTurn, MARK } from "../plugins/finish-guard.js";

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

test("readTurn stops at the current turn's start even when this turn has no todo list", () => {
  const s = session([
    { type: "turn/start", data: { turn: 1 } }, user("old request"), todos([{ content: "x", status: "pending" }]), reply("old reply"),
    { type: "turn/start", data: { turn: 2 } }, user("new request"), reply("new reply"),
  ]);
  const facts = readTurn(s, 2);
  assert.equal(facts.finalText, "new reply");
  assert.equal(facts.userText, "new request");
  assert.deepEqual(facts.todos, [], "an earlier turn's todo list is never read");
});

test("USER_STOP covers explicit stop wording but not ordinary requests about stopping", () => {
  const base = { todos: [{ content: "b", status: "pending" }], finalText: "ok", pushes: 0 };
  const stops = ["Please stop here.", "don't make any edits", "do not change anything", "stop.", "that's enough, stop", "no more changes"];
  for (const userText of stops) {
    assert.equal(finishVerdict({ ...base, userText }).block, false, `should not push on: ${userText}`);
  }
  const requests = ["fix the stop button", "make the service stop gracefully"];
  for (const userText of requests) {
    assert.equal(finishVerdict({ ...base, userText }).block, true, `should still push on: ${userText}`);
  }
});

test("a subagent child is left alone unless the row asks for it", () => {
  const events = [{ type: "turn/start", data: { turn: 1 } }, user("do it"), reply("Remaining items: b")];
  const child = (header) => {
    const steered = [];
    return { steered, agent: { session: { ...session(events), header }, steer: (m) => steered.push(m) } };
  };
  const signal = { aborted: false };
  for (const header of [{ origin: "subagent" }, { delegationDepth: 1 }, { origin: "subagent", delegationDepth: 2 }]) {
    const c = child(header);
    assert.equal(isSubagent(c.agent), true);
    harness({})({ agent: c.agent, turn: 1, signal });
    assert.equal(c.steered.length, 0, `no push for ${JSON.stringify(header)}`);
    harness({ subagents: true })({ agent: c.agent, turn: 1, signal });
    assert.equal(c.steered.length, 1, "subagents: true pushes a child too");
  }
  for (const header of [undefined, {}, { delegationDepth: 0 }, { parentSession: "an-ordinary-fork" }]) {
    const root = child(header);
    assert.equal(isSubagent(root.agent), false);
    harness({})({ agent: root.agent, turn: 1, signal });
    assert.equal(root.steered.length, 1, `a top-level session is still pushed for ${JSON.stringify(header)}`);
  }
});
