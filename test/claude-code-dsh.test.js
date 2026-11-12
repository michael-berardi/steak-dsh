// The route inside a real dsh headless run (skipped when dsh is not installed), with the fake CLI standing in for claude.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { FAKE, readLog, root, scratchDir, warmFake, alive } from "./cc-helpers.js";

const dshOnPath = (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, "dsh")));
const launcher = join(root, "bin", "steak-dsh");

before(() => warmFake());

function run(args, dir, fakeEnv) {
  const log = join(dir, "fake.log");
  const result = spawnSync(process.execPath, [launcher, "run", "--json", ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: process.env.DSH_HOME,
      STEAK_DSH_CLAUDE_CODE_COMMAND: FAKE, FAKE_CLAUDE_LOG: log, ...fakeEnv,
    },
  });
  const events = result.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  return { result, events, log };
}

test("dsh headless --patch: a claude-code model answers through the route, with usage", { skip: !dshOnPath }, () => {
  const dir = realpathSync(scratchDir());
  try {
    const { result, events, log } = run(["--model", "claude-code/default", "say hi"], dir, { FAKE_CLAUDE_MODE: "text", FAKE_CLAUDE_TEXT: "hi from the fake" });
    assert.equal(result.status, 0, result.stderr);
    const final = events.find((e) => e.type === "final");
    assert.equal(final.reason.kind, "completed");
    assert.equal(final.text, "hi from the fake");
    const step = events.find((e) => e.type === "status" && e.phase === "step_end");
    assert.deepEqual(step.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 26, cacheReadTokens: 5, cacheWriteTokens: 3 });
    const launches = readLog(log).filter((e) => e.event === "launch" && !e.discovery);
    assert.equal(launches.length, 1);
    assert.equal(alive(launches[0].pid), false, "no Claude process outlives the run");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dsh headless --patch: Claude Code requests a harness tool, the harness runs it, the result comes back", { skip: !dshOnPath }, () => {
  const dir = realpathSync(scratchDir());
  try {
    const target = join(dir, "made.txt");
    const { result, events, log } = run(["--model", "claude-code/default", "create the file"], dir, {
      FAKE_CLAUDE_MODE: "tool-then-text", FAKE_CLAUDE_TOOL: "write", FAKE_CLAUDE_TOOL_INPUT: JSON.stringify({ file_path: target, content: "written by the harness\n" }), FAKE_CLAUDE_TEXT: "created",
    });
    assert.equal(result.status, 0, result.stderr + result.stdout.slice(-500));
    assert.equal(readFileSync(target, "utf8"), "written by the harness\n");
    const final = events.find((e) => e.type === "final");
    assert.equal(final.text, "created");
    const queries = readLog(log).filter((e) => e.event === "query");
    assert.equal(queries.length, 2, "one request per harness turn: the tool call, then the answer");
    assert.deepEqual(queries[1].frames.at(-1).blocks, ["tool_result"]);
    for (const launch of readLog(log).filter((e) => e.event === "launch")) assert.equal(alive(launch.pid), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dsh headless --patch: with no Claude Code installed the run fails with one named error", { skip: !dshOnPath }, () => {
  const dir = realpathSync(scratchDir());
  try {
    const { events } = run(["--model", "claude-code/default", "hi"], dir, { STEAK_DSH_CLAUDE_CODE_COMMAND: join(dir, "missing-claude") });
    const final = events.find((e) => e.type === "final");
    assert.equal(final.reason.kind, "error");
    assert.equal(final.reason.error.code, "CLAUDE_CODE_NOT_READY");
    assert.match(final.reason.error.message, /not installed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
