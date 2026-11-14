// The finish guard against the harness's own todo tool, inside a real dsh headless run (skipped when dsh is not
// installed). A scripted model calls the native `todo_write` tool with one open item and then stops: the guard must
// see that item (the harness's own `todo/write` session event, not a fabricated one) and keep the turn open.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { FAKE, readLog, root, scratchDir, warmFake } from "./cc-helpers.js";

const dshOnPath = (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, "dsh")));
const launcher = join(root, "bin", "steak-dsh");

before(() => warmFake());

function run(args, dir, fakeEnv) {
  const log = join(dir, "fake.log");
  const result = spawnSync(process.execPath, [launcher, "run", "--json", ...args], {
    cwd: dir, encoding: "utf8", timeout: 120_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: join(dir, ".dsh-home"), STEAK_DSH_CLAUDE_CODE_COMMAND: FAKE, FAKE_CLAUDE_LOG: log, ...fakeEnv },
  });
  const events = result.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  return { result, events, queries: readLog(log).filter((e) => e.event === "query") };
}

const todos = (status) => JSON.stringify({ todos: [{ content: "write the parser", status }] });

test("the native todo_write tool's open item keeps the turn open (the guard reads the harness's own event)", { skip: !dshOnPath }, () => {
  const dir = realpathSync(scratchDir());
  try {
    const { result, queries } = run(["--model", "claude-code/default", "build the parser"], dir, {
      FAKE_CLAUDE_MODE: "tool-then-text", FAKE_CLAUDE_TOOL: "todo_write", FAKE_CLAUDE_TOOL_INPUT: todos("pending"), FAKE_CLAUDE_TEXT: "All set.",
    });
    assert.equal(result.status, 0, result.stderr + result.stdout.slice(-400));
    // Without a push the run is two requests: the tool call, then the answer. The scripted model repeats that pair on
    // every push (it calls the tool again, then answers), so three pushes, the guard's limit, make exactly 2 + 3 x 2.
    assert.equal(queries.length, 8, `three pushes, then the guard lets the turn end (requests: ${queries.length})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a completed native todo list lets the turn end at once", { skip: !dshOnPath }, () => {
  const dir = realpathSync(scratchDir());
  try {
    const { result, events, queries } = run(["--model", "claude-code/default", "build the parser"], dir, {
      FAKE_CLAUDE_MODE: "tool-then-text", FAKE_CLAUDE_TOOL: "todo_write", FAKE_CLAUDE_TOOL_INPUT: todos("completed"), FAKE_CLAUDE_TEXT: "All set.",
    });
    assert.equal(result.status, 0, result.stderr + result.stdout.slice(-400));
    assert.equal(queries.length, 2, "no push: the tool call, then the answer");
    assert.equal(events.find((e) => e.type === "final").text, "All set.");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
