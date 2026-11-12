import test from "node:test";
import assert from "node:assert/strict";
import { Controller } from "../lib/tui/session.js";
import { ev, makeFakeDsh, status, textMsg, toolResult, until } from "./tui-helpers.js";

const OPTIONS = { provider: "gw", model: "example-model-1", effort: "high", permission: "workspace-write", addDirs: [] };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const APPROVAL = { method: "approval/request", params: { sessionId: "$SESSION", toolName: "bash", callId: "c1", reason: "run the tests" } };

async function boot(scenario, options = {}, timing = { killGraceMs: 300, shutdownGraceMs: 1500 }) {
  const fake = makeFakeDsh(scenario);
  const c = new Controller({ bin: fake.bin, args: ["--profile", "sdk", "--patch", "/tmp/x.yml"], options: { ...OPTIONS, ...options }, cwd: process.cwd(), env: fake.env, timing });
  await c.start();
  return { fake, c };
}

const finish = async (c, fake) => {
  await c.quit();
  for (const s of fake.starts()) assert.ok(!alive(s.start), `child ${s.start} was left running`);
};

test("start: spawns `dsh --profile sdk` with the overlay patches, initializes with approvals and questions opted in", async () => {
  const { fake, c } = await boot({});
  assert.deepEqual(fake.starts()[0].argv, ["--profile", "sdk", "--patch", "/tmp/x.yml"]);
  const init = fake.received("initialize")[0].params;
  assert.equal(init.provider, "gw");
  assert.equal(init.model, "example-model-1");
  assert.equal(init.reasoningEffort, "high");
  assert.equal(init.approvalRequests, true);
  assert.deepEqual(init.capabilities, { userQuestions: true });
  assert.equal(c.state.phase, "ready");
  assert.equal(c.state.detail, "new session");
  assert.equal(fake.received("session/resume").length, 0, "a new session is not resumed");
  await finish(c, fake);
});

test("a full scripted turn: prompt, tool call and result with a diff, text, usage, settle", async () => {
  const { fake, c } = await boot({ onPrompt: [
    status("running"), ev({ type: "turn/start", turn: 1 }),
    ev({ type: "request/context", provider: "gw", model: "m", contextWindow: 100000 }),
    ev({ type: "tool/call", turn: 1, step: 1, callId: "c1", name: "edit", arguments: JSON.stringify({ file_path: "a.js" }) }),
    ev({ type: "tool/result", turn: 1, step: 1, message: toolResult("c1", "ok"), meta: { diffs: [{ path: "/nonexistent/a.js", oldText: "a", newText: "b" }] } }),
    ev({ type: "assistant/message", turn: 1, step: 2, stream: [], message: textMsg("All done."), usage: { inputTokens: 900, outputTokens: 100, cacheReadTokens: 100 } }),
    ev({ type: "turn/end", turn: 1, reason: { kind: "completed" } }), status("idle"),
  ] });
  await c.submit("please edit");
  const prompt = fake.received("session/prompt")[0].params;
  assert.equal(prompt.sessionId, c.state.sessionId);
  assert.deepEqual(prompt.contentBlocks, [{ type: "text", text: "please edit" }]);
  await until(() => c.state.phase === "complete", "complete");
  assert.deepEqual(c.state.blocks.map((b) => b.kind), ["user", "tool", "assistant"]);
  assert.equal(c.state.blocks[1].status, "success");
  assert.equal(c.state.blocks[1].meta.diffs[0].newStart, undefined, "an unreadable file leaves the hunk relative, without throwing");
  assert.equal(c.state.contextWindow, 100000);
  assert.equal(c.state.usage.requests, 1);
  await finish(c, fake);
});

test("slash commands other than the local ones go to session/query; /new starts a fresh session id", async () => {
  const { fake, c } = await boot({ onQuery: [ev({ type: "turn/start", turn: 1 }), ev({ type: "turn/end", turn: 1, reason: { kind: "completed" } }), status("idle")] });
  const first = c.state.sessionId;
  await c.submit("/compact now");
  assert.deepEqual(fake.received("session/query")[0].params.contentBlocks, [{ type: "text", text: "/compact now" }]);
  assert.equal(fake.received("session/prompt").length, 0);
  await until(() => c.state.phase === "complete", "complete");
  await c.submit("/new");
  assert.notEqual(c.state.sessionId, first);
  assert.equal(c.state.blocks.length, 0);
  assert.deepEqual(await c.submit("/exit"), { quit: true });
  await finish(c, fake);
});

test("approval: allow and reject answers reach the harness; nothing is allowed by default", async () => {
  const { fake, c } = await boot({ onPrompt: [status("running"), { request: APPROVAL, name: "first" }, { request: APPROVAL, name: "second" }] });
  await c.submit("go");
  await until(() => c.state.prompt, "first prompt");
  assert.equal(c.state.phase, "waiting");
  assert.equal(c.state.detail, "bash");
  assert.equal(fake.entries().some((e) => e.answer), false, "no answer is sent before the user decides");
  c.promptEvent({ type: "key", name: "enter" });
  await until(() => c.state.prompt, "second prompt");
  c.promptEvent({ type: "key", name: "escape" });
  await until(() => fake.entries().filter((e) => e.answer).length === 2, "both answers");
  const answers = Object.fromEntries(fake.entries().filter((e) => e.answer).map((e) => [e.answer, e.result]));
  assert.deepEqual(answers, { first: { outcome: "allowed-once" }, second: { outcome: "rejected" } });
  assert.equal(c.state.prompt, undefined);
  await finish(c, fake);
});

test("approval fails closed when the child dies: the prompt is dropped, nothing is allowed, the error is shown", async () => {
  const { fake, c } = await boot({ onPrompt: [status("running"), { request: APPROVAL, name: "doomed", noWait: true }, { delay: 80 }, { stderr: "fatal: out of memory\n" }, { crash: "SIGKILL" }] });
  await c.submit("go");
  await until(() => c.state.prompt, "prompt opened");
  await until(() => !c.state.childAlive, "child gone");
  assert.equal(c.state.prompt, undefined, "the prompt is dropped");
  assert.equal(c.pending.size, 0);
  assert.equal(c.state.phase, "error");
  assert.equal(c.state.detail, "harness exited");
  const error = c.state.blocks.at(-1);
  assert.equal(error.kind, "error");
  assert.match(error.text, /stopped by SIGKILL.*out of memory/);
  assert.match(error.text, /refused/);
  assert.equal(fake.entries().some((e) => e.answer), false, "no decision was ever delivered");
  assert.equal(c.promptEvent({ type: "key", name: "enter" }), false, "a late Enter finds no prompt to allow");
  await finish(c, fake);
});

test("child crash: the next message restarts the harness and resumes the same session", async () => {
  const { fake, c } = await boot({ onPrompt: [{ crash: "SIGKILL", onStart: 0 }] });
  const session = c.state.sessionId;
  await c.submit("first");
  await until(() => !c.state.childAlive, "crash seen");
  await c.submit("second");
  await until(() => fake.starts().length === 2, "second child");
  const resumes = fake.received("session/resume");
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0].params.sessionId, session);
  assert.equal(fake.received("initialize").length, 2);
  assert.equal(fake.received("session/prompt").length, 2);
  assert.equal(c.state.childAlive, true);
  await finish(c, fake);
});

test("cancel: SIGINT to the child, respawn, initialize and session/resume; the old child is gone", async () => {
  const { fake, c } = await boot({ onPrompt: [status("running"), ev({ type: "turn/start", turn: 1 }), ev({ type: "tool/call", turn: 1, step: 1, callId: "c1", name: "bash", arguments: "{\"command\":\"sleep 999\"}" }), { hang: true }] });
  const session = c.state.sessionId;
  await c.submit("long job");
  await until(() => c.state.phase === "tool", "tool running");
  const firstPid = fake.starts()[0].start;
  assert.equal(await c.cancel(), true);
  assert.ok(fake.entries().some((e) => e.sigint), "the child got SIGINT");
  assert.equal(fake.starts().length, 2, "a replacement child was started");
  assert.ok(!alive(firstPid), "the first child is gone");
  assert.equal(fake.received("initialize").length, 2);
  assert.equal(fake.received("session/resume").at(-1).params.sessionId, session);
  assert.equal(c.state.phase, "stopped");
  assert.equal(c.state.detail, "cancelled");
  assert.equal(c.state.busy, false);
  assert.equal(c.state.blocks.find((b) => b.kind === "tool").status, "error", "the pending card is closed as interrupted");
  assert.equal(c.state.sessionId, session, "same session");
  await c.submit("again");
  assert.equal(fake.received("session/prompt").at(-1).params.sessionId, session, "the new child takes prompts for the same session");
  assert.equal(await c.cancel(), true);
  await finish(c, fake);
});

test("cancel while an approval is open refuses it; a child that ignores SIGINT is killed after the grace period", async () => {
  const { fake, c } = await boot({ ignoreSigint: true, onPrompt: [status("running"), { request: APPROVAL, name: "x", noWait: true }, { hang: true }] }, {}, { killGraceMs: 200, shutdownGraceMs: 800 });
  await c.submit("go");
  await until(() => c.state.prompt, "prompt");
  const firstPid = fake.starts()[0].start;
  const started = Date.now();
  await c.cancel();
  assert.ok(Date.now() - started >= 150, "waited for the grace period before SIGKILL");
  assert.ok(!alive(firstPid), "SIGKILL reaped the stubborn child");
  assert.equal(c.state.prompt, undefined);
  assert.equal(c.pending.size, 0);
  assert.equal(fake.entries().some((e) => e.answer && e.result?.outcome === "allowed-once"), false);
  await finish(c, fake);
});

test("cancel does nothing when idle", async () => {
  const { fake, c } = await boot({});
  assert.equal(await c.cancel(), false);
  assert.equal(fake.starts().length, 1);
  await finish(c, fake);
});

test("user question: answers are returned in the wire shape, dismissal is { cancelled: true }", async () => {
  const ask = (id) => ({ method: "user-question/ask", params: { requestId: id, sessionId: "$SESSION", questions: [{ id: "q1", question: "Which?", options: [{ label: "a" }, { label: "b" }] }] } });
  const { fake, c } = await boot({ onPrompt: [status("running"), { request: ask("r1"), name: "one" }, { request: ask("r2"), name: "two" }] });
  await c.submit("go");
  await until(() => c.state.prompt?.kind === "question", "question");
  c.promptEvent({ type: "key", name: "down" });
  c.promptEvent({ type: "key", name: "enter" });
  await until(() => c.state.prompt, "second question");
  c.promptEvent({ type: "key", name: "escape" });
  await until(() => fake.entries().filter((e) => e.answer).length === 2, "answers");
  const a = Object.fromEntries(fake.entries().filter((e) => e.answer).map((e) => [e.answer, e.result]));
  assert.deepEqual(a, { one: { answers: [{ id: "q1", selected: ["b"] }] }, two: { cancelled: true } });
  await finish(c, fake);
});

test("a withdrawn question (user-question.cancelled) closes its prompt without an answer", async () => {
  const q = { method: "user-question/ask", params: { requestId: "r9", sessionId: "$SESSION", questions: [{ id: "q", question: "?" }] } };
  const { fake, c } = await boot({ onPrompt: [status("running"), { request: q, name: "q", noWait: true }, { delay: 30 }, { notify: { method: "user-question.cancelled", params: { requestId: "r9", sessionId: "$SESSION" } } }, { hang: true }] });
  await c.submit("go");
  await until(() => c.state.prompt, "question");
  await until(() => !c.state.prompt, "withdrawn");
  assert.equal(c.pending.size, 0);
  await c.cancel();
  await finish(c, fake);
});

test("startup failures are reported, not thrown: initialize rejected, and a missing executable", async () => {
  const fake = makeFakeDsh({ initialize: { error: { code: -32603, message: 'no adapter registered for provider "gw"' } } });
  const c = new Controller({ bin: fake.bin, args: ["--profile", "sdk"], options: OPTIONS, cwd: process.cwd(), env: fake.env, timing: { killGraceMs: 300 } });
  await c.start();
  assert.equal(c.state.phase, "error");
  assert.match(c.state.blocks.find((b) => b.kind === "error").text, /harness did not start: no adapter registered/);
  assert.ok(!alive(fake.starts()[0].start), "the child that rejected initialize was stopped");
  const missing = new Controller({ bin: "/nonexistent/dsh-binary", args: [], options: OPTIONS, cwd: process.cwd(), env: process.env });
  await missing.start();
  assert.match(missing.state.blocks[0].text, /could not start dsh/);
  assert.equal(missing.state.childAlive, false);
});

test("--session-id resumes at startup; a failed resume is a notice, not a crash; --permission is applied by command", async () => {
  const { fake, c } = await boot({ resume: { error: { code: -32603, message: "session not found" } } }, { sessionId: "abc-123", permission: "read-only" });
  assert.equal(fake.received("session/resume")[0].params.sessionId, "abc-123");
  assert.match(c.state.blocks.find((b) => b.kind === "notice").text, /could not be resumed \(session not found\)/);
  assert.deepEqual(fake.received("session/query")[0].params.contentBlocks, [{ type: "text", text: "/permission read-only" }]);
  assert.equal(c.state.phase, "ready");
  await finish(c, fake);
});

test("quit: protocol shutdown, stdin closed, child reaped", async () => {
  const { fake, c } = await boot({});
  const pid = fake.starts()[0].start;
  await c.quit();
  assert.equal(fake.received("shutdown").length, 1);
  assert.ok(!alive(pid));
});

test("a harness that never answers shutdown and ignores EOF is terminated by SIGTERM", async () => {
  const { fake, c } = await boot({ stubbornShutdown: true }, {}, { killGraceMs: 200, shutdownGraceMs: 150 });
  const pid = fake.starts()[0].start;
  await c.quit();
  assert.ok(fake.entries().some((e) => e.sigterm), "SIGTERM was needed");
  assert.ok(!alive(pid));
});

test("quitting while a cancel is in flight leaves no child behind", async () => {
  const { fake, c } = await boot({ onPrompt: [status("running"), ev({ type: "turn/start", turn: 1 }), { hang: true }] });
  await c.submit("go");
  await until(() => c.state.busy, "busy");
  const cancelling = c.cancel();
  await c.quit();
  await cancelling;
  await new Promise((r) => setTimeout(r, 100));
  for (const s of fake.starts()) assert.ok(!alive(s.start), `child ${s.start} leaked`);
});
