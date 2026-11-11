import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, runCommand, verifySettings, failureText } from "../plugins/verify-after-edit.js";

const scratch = () => mkdtempSync(join(tmpdir(), "steak-dsh-test-"));

test("no command configured means no verification", () => {
  const home = scratch(), project = scratch();
  try {
    assert.equal(verifySettings(project, {}, home), undefined);
  } finally { rmSync(home, { recursive: true }); rmSync(project, { recursive: true }); }
});

test("a project file is ignored until the user trusts that project", () => {
  const home = scratch(), project = scratch();
  try {
    mkdirSync(join(project, ".steak-dsh"));
    writeFileSync(join(project, ".steak-dsh", "config.json"), JSON.stringify({ verify: { command: "echo pwned" } }));
    assert.equal(verifySettings(project, {}, home), undefined, "an untrusted repository cannot make the harness run a command");
    writeFileSync(join(home, "steak-dsh.json"), JSON.stringify({ trusted: [project] }));
    assert.equal(verifySettings(project, {}, home).command, "echo pwned");
    writeFileSync(join(home, "steak-dsh.json"), JSON.stringify({ projects: { [project]: { verify: { command: "make check", failLimit: 4 } } } }));
    assert.deepEqual(verifySettings(project, {}, home), { command: "make check", failLimit: 4, timeoutMs: 90000 });
    assert.equal(verifySettings(project, { command: "npm test" }, home).command, "npm test", "row config wins");
  } finally { rmSync(home, { recursive: true }); rmSync(project, { recursive: true }); }
});

test("runCommand reports exit code, output tail and timeouts", async () => {
  const dir = scratch();
  try {
    const ok = await runCommand("echo hi", dir, 5000);
    assert.equal(ok.code, 0);
    assert.match(ok.output, /hi/);
    const bad = await runCommand("echo boom >&2; exit 3", dir, 5000);
    assert.equal(bad.code, 3);
    assert.match(bad.output, /boom/);
    const slow = await runCommand("sleep 5", dir, 200);
    assert.equal(slow.timedOut, true);
    assert.match(failureText({ command: "sleep 5", failLimit: 2, timeoutMs: 200 }, 1, slow), /timed out after 200 ms/);
  } finally { rmSync(dir, { recursive: true }); }
});

const harness = (config, cwd) => {
  const handlers = {};
  apply({ on: (name, fn) => { handlers[name] = fn; }, get: () => ({ get: () => cwd }) }, config);
  return handlers["tools/post-execute"];
};
const accept = async () => ({ kind: "accept" });
const exec = (name, agent) => ({ name, agent, signal: { aborted: false, addEventListener() {}, removeEventListener() {} } });

test("a failing check is handed back with the edit result, then stops after the fail limit", async () => {
  const dir = scratch();
  try {
    const post = harness({ command: "echo broken; exit 1", failLimit: 2 }, dir);
    const agent = { session: {} };
    const first = await post(exec("edit", agent), { isError: false }, accept);
    assert.equal(first.additionalContexts.length, 1);
    assert.match(first.additionalContexts[0].content[0].text, /verify failed \(attempt 1\/2, exit code 1\)[\s\S]*broken/);
    const second = await post(exec("write", agent), { isError: false }, accept);
    assert.match(second.additionalContexts[0].content[0].text, /attempt 2\/2/);
    const third = await post(exec("edit", agent), { isError: false }, accept);
    assert.equal(third.additionalContexts, undefined, "no endless loop");
  } finally { rmSync(dir, { recursive: true }); }
});

test("a passing check says so; reads, failed edits and unconfigured projects are left alone", async () => {
  const dir = scratch();
  try {
    const post = harness({ command: "true" }, dir);
    const agent = { session: {} };
    const pass = await post(exec("edit", agent), { isError: false }, accept);
    assert.match(pass.additionalContexts[0].content[0].text, /verify passed: true/);
    assert.equal((await post(exec("read", agent), { isError: false }, accept)).additionalContexts, undefined);
    assert.equal((await post(exec("edit", agent), { isError: true }, accept)).additionalContexts, undefined);
    const none = harness({}, dir);
    const saved = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      assert.equal((await none(exec("edit", agent), { isError: false }, accept)).additionalContexts, undefined);
    } finally { if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved; }
  } finally { rmSync(dir, { recursive: true }); }
});

test("runCommand settles on exit even when a background job holds the pipes open", async () => {
  const dir = scratch();
  try {
    const started = Date.now();
    const result = await runCommand("sleep 30 & exit 1", dir, 5000);
    const elapsed = Date.now() - started;
    assert.equal(result.code, 1);
    assert.equal(result.timedOut, false);
    assert.ok(elapsed < 2000, `resolved in ${elapsed} ms, under 2 s`);
  } finally { rmSync(dir, { recursive: true }); }
});

test("runCommand: a command that ignores TERM still resolves within 1 s of the timeout", async () => {
  const dir = scratch();
  try {
    const started = Date.now();
    const result = await runCommand("trap '' TERM; sleep 30", dir, 300);
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, true);
    assert.ok(elapsed < 1300, `resolved in ${elapsed} ms (timeout 300 ms + under 1 s)`);
  } finally { rmSync(dir, { recursive: true }); }
});

const fullHarness = (config, cwd, { noPreStep = false } = {}) => {
  const handlers = {};
  apply({
    on: (name, fn) => {
      if (noPreStep && name === "agent/pre-step") throw new Error(`unknown event ${name}`);
      handlers[name] = fn;
    },
    get: () => ({ get: () => cwd }),
  }, config);
  return handlers;
};

test("a run cut short by an abort is not a failure and is not counted", async () => {
  const dir = scratch();
  try {
    const post = fullHarness({ command: "sleep 0.5", failLimit: 1 }, dir)["tools/post-execute"];
    const agent = { session: {} };
    const controller = new AbortController();
    const aborted = { name: "edit", agent, signal: controller.signal };
    setTimeout(() => controller.abort(), 300); // after the 150 ms debounce, while the command runs
    const first = await post(aborted, { isError: false }, accept);
    assert.equal(first.additionalContexts, undefined, "an aborted run leaves the decision unchanged");
    const second = await post(exec("edit", agent), { isError: false }, accept);
    assert.match(second.additionalContexts[0].content[0].text, /verify passed/, "the abort did not use up the fail limit");
  } finally { rmSync(dir, { recursive: true }); }
});

test("after the fail limit verification pauses for that turn only and resumes on the next turn", async () => {
  const dir = scratch();
  try {
    const handlers = fullHarness({ command: "echo broken; exit 1", failLimit: 2 }, dir);
    const post = handlers["tools/post-execute"];
    const pre = handlers["agent/pre-step"];
    assert.ok(pre, "agent/pre-step listener registered");
    const agent = { session: {} };
    const sentinel = { kind: "accept" };
    assert.equal(pre({ agent, turn: 1, step: 1 }, () => sentinel), sentinel, "waterfall returns next() unchanged");
    const first = await post(exec("edit", agent), { isError: false }, accept);
    assert.match(first.additionalContexts[0].content[0].text, /attempt 1\/2/);
    assert.equal(first.additionalContexts[0].content[0].text.includes("paused"), false);
    const second = await post(exec("edit", agent), { isError: false }, accept);
    assert.match(second.additionalContexts[0].content[0].text, /attempt 2\/2/);
    assert.match(second.additionalContexts[0].content[0].text, /Verification is paused until your next request\./);
    assert.equal((await post(exec("edit", agent), { isError: false }, accept)).additionalContexts, undefined, "paused");
    pre({ agent, turn: 1, step: 2 }, () => sentinel);
    assert.equal((await post(exec("edit", agent), { isError: false }, accept)).additionalContexts, undefined, "same turn stays paused");
    pre({ agent, turn: 2, step: 1 }, () => sentinel);
    const resumed = await post(exec("edit", agent), { isError: false }, accept);
    assert.match(resumed.additionalContexts[0].content[0].text, /attempt 1\/2/, "a new turn resets the count");
  } finally { rmSync(dir, { recursive: true }); }
});

test("a harness without agent/pre-step still loads the plugin", async () => {
  const dir = scratch();
  try {
    const handlers = fullHarness({ command: "true" }, dir, { noPreStep: true });
    assert.equal(handlers["agent/pre-step"], undefined);
    const post = handlers["tools/post-execute"];
    assert.ok(post, "tools/post-execute still registered");
    const result = await post(exec("edit", { session: {} }), { isError: false }, accept);
    assert.match(result.additionalContexts[0].content[0].text, /verify passed/);
  } finally { rmSync(dir, { recursive: true }); }
});
