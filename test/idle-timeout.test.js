// test-timing: serial
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { IDLE_TIMEOUT_ENV, parseIdleTimeoutSec, parseOptions } from "../lib/args.js";
import { IDLE_TIMEOUT_EXIT_CODE, runCommand } from "../lib/run.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(root, "bin", "steak-dsh");

/**
 * The idle watchdog is armed when dsh is spawned, so every idle window below also covers the fake dsh's own start-up.
 * A bare `node` start took up to 515 ms on this Mac under 2x CPU oversubscription, so a sub-second window could expire
 * before the fake had run a single line (seen as false stalls and "waited idle + grace" misses). Windows that must NOT
 * expire before the fake acts are IDLE_SEC; each scenario's own delays are sized from it so what it proves is unchanged.
 */
const IDLE_SEC = 2;
const IDLE_MS = IDLE_SEC * 1000;

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

function makeFakeDsh(dir) {
  const fake = join(dir, "fake-dsh.mjs");
  const script = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  process.stdout.write("0.2.2-rc.1\\n");
  process.exit(0);
}
const mode = process.env.FAKE_MODE ?? "stall";
const pidFile = process.env.FAKE_PID_FILE;
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

if (mode === "stall") {
  if (pidFile) writeFileSync(pidFile, JSON.stringify({ child: process.pid }) + "\\n");
  emit({ type: "session", sessionId: "sess-stall-1", cwd: process.cwd() });
  emit({ type: "status", phase: "turn_start", turn: 1 });
  setInterval(() => {}, 1000);
} else if (mode === "partial-line-stall") {
  emit({ type: "session", sessionId: "sess-partial", cwd: process.cwd() });
  process.stdout.write('{"type":"text","text":"incomplete');
  setInterval(() => {}, 1000);
} else if (mode === "stubborn-group") {
  process.on("SIGTERM", () => {});
  const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });
  if (pidFile) writeFileSync(pidFile, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }) + "\\n");
  emit({ type: "session", sessionId: "sess-group", cwd: process.cwd() });
  setInterval(() => {}, 1000);
} else if (mode === "child-exits-grandchild-stubborn") {
  const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });
  if (pidFile) writeFileSync(pidFile, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }) + "\\n");
  process.on("SIGTERM", () => process.exit(0));
  emit({ type: "session", sessionId: "sess-orphan", cwd: process.cwd() });
  setInterval(() => {}, 1000);
} else if (mode === "tool-pause-completes") {
  const delayMs = Number(process.env.FAKE_TOOL_MS ?? 450);
  emit({ type: "session", sessionId: "sess-tool", cwd: process.cwd() });
  emit({ type: "tool_call", callId: "c1", tool: "bash", input: { command: "sleep 1" } });
  setTimeout(() => {
    emit({ type: "tool_result", callId: "c1", status: "completed", result: "done" });
    emit({ type: "text", text: "finished after tool" });
    emit({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } });
    emit({ type: "final", sessionId: "sess-tool", reason: { kind: "completed" }, text: "finished after tool" });
    process.exit(0);
  }, delayMs);
} else if (mode === "parallel-tools-then-stall") {
  const delayMs = Number(process.env.FAKE_TOOL_MS ?? 350);
  emit({ type: "session", sessionId: "sess-par", cwd: process.cwd() });
  emit({ type: "tool_call", callId: "c1", tool: "bash", input: {} });
  emit({ type: "tool_call", callId: "c2", tool: "bash", input: {} });
  setTimeout(() => {
    emit({ type: "tool_result", callId: "c1", status: "completed", result: "r1" });
    // c2 is still open: stay silent longer than idle timeout before closing c2, then stall after c2 closes!
    setTimeout(() => {
      emit({ type: "tool_result", callId: "c2", status: "completed", result: "r2" });
      setInterval(() => {}, 1000);
    }, delayMs);
  }, 50);
} else if (mode === "exit-with-stdout-holder" || mode === "exit-with-stubborn-stdout-holder") {
  const ignoreTerm = mode === "exit-with-stubborn-stdout-holder";
  const readyFile = pidFile + ".ready";
  const holderScript =
    (ignoreTerm ? "process.on('SIGTERM', () => {}); " : "") +
    "require('node:fs').writeFileSync(process.env.HOLDER_READY, 'ok'); setInterval(() => {}, 1000);";
  const holder = spawn(process.execPath, ["-e", holderScript], {
    stdio: ["ignore", 1, "ignore"],
    env: { ...process.env, HOLDER_READY: readyFile },
  });
  if (pidFile) writeFileSync(pidFile, JSON.stringify({ child: process.pid, holder: holder.pid }) + "\\n");
  emit({ type: "session", sessionId: "sess-holder", cwd: process.cwd() });
  // Wait until holder has installed its SIGTERM handler before emitting final and exiting.
  const { existsSync } = await import("node:fs");
  const deadline = Date.now() + 5000;
  while (!existsSync(readyFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  emit({ type: "final", sessionId: "sess-holder", reason: { kind: "completed" }, text: "ok" });
  process.exit(0);
} else if (mode === "slow-consumer-burst") {
  emit({ type: "session", sessionId: "sess-slow", cwd: process.cwd() });
  for (let i = 0; i < 8; i++) {
    emit({ type: "text", text: "chunk-" + i + "-" + "a".repeat(256) });
    await new Promise((r) => setTimeout(r, 25));
  }
  emit({ type: "final", sessionId: "sess-slow", reason: { kind: "completed" }, text: "all-delivered" });
  process.exit(0);
} else if (mode === "epipe-spam") {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
  if (pidFile) writeFileSync(pidFile, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }) + "\\n");
  emit({ type: "session", sessionId: "sess-epipe", cwd: process.cwd() });
  const big = "x".repeat(32768);
  setInterval(() => emit({ type: "text", text: big }), 10);
}
`;
  writeFileSync(fake, script, { mode: 0o755 });
  return fake;
}

test("parseOptions & parseIdleTimeoutSec: flag, env precedence, validation, and scope", () => {
  assert.equal(parseIdleTimeoutSec("30"), 30);
  assert.equal(parseIdleTimeoutSec("0.25"), 0.25);
  assert.throws(() => parseIdleTimeoutSec("0"), /positive number of seconds/);
  assert.throws(() => parseIdleTimeoutSec("-5"), /positive number of seconds/);
  assert.throws(() => parseIdleTimeoutSec("abc"), /positive number of seconds/);
  assert.throws(() => parseIdleTimeoutSec("Infinity"), /positive number of seconds/);
  assert.throws(() => parseIdleTimeoutSec("9999999"), /at most/);

  assert.equal(parseOptions(["--json", "--idle-timeout", "12", "task"], { env: {} }).options.idleTimeoutSec, 12);
  assert.equal(parseOptions(["--json", "task"], { env: { [IDLE_TIMEOUT_ENV]: "45" } }).options.idleTimeoutSec, 45);
  assert.equal(parseOptions(["--json", "--idle-timeout", "10", "task"], { env: { [IDLE_TIMEOUT_ENV]: "45" } }).options.idleTimeoutSec, 10, "CLI flag overrides env");
  assert.equal(parseOptions(["task"], { env: { [IDLE_TIMEOUT_ENV]: "45" } }).options.idleTimeoutSec, undefined, "ambient env is inactive without --json");
  assert.equal(parseOptions([], { allowTask: false, command: "tui", env: { [IDLE_TIMEOUT_ENV]: "45" } }).options.idleTimeoutSec, undefined, "ambient env does not break tui");

  assert.throws(() => parseOptions(["--idle-timeout", "10", "task"], { env: {} }), /--idle-timeout requires --json/);
  assert.throws(() => parseOptions(["--idle-timeout", "10"], { allowTask: false, command: "chat", env: {} }), /applies to run --json only/);
  assert.throws(() => parseOptions(["--idle-timeout", "10"], { allowTask: false, command: "tui", env: {} }), /applies to run --json only/);
  assert.throws(() => parseOptions(["--json", "task"], { env: { [IDLE_TIMEOUT_ENV]: "nope" } }), /STEAK_DSH_IDLE_TIMEOUT_SEC must be a positive number of seconds/);
});

test("idle timeout via CLI flag and env: stalls terminate child, emit valid stalled-stream JSON + stderr, and exit 124", () => {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-idle-cli-"));
  try {
    const fake = makeFakeDsh(dir);
    const pidFile = join(dir, "pids.json");
    const runWith = (args, extraEnv = {}) => spawnSync(process.execPath, [launcher, ...args], {
      cwd: dir,
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, STEAK_DSH_DSH_BIN: fake, FAKE_MODE: "stall", FAKE_PID_FILE: pidFile, DSH_HOME: join(dir, "home"), ...extraEnv },
    });

    for (const [label, args, extraEnv] of [
      ["CLI --idle-timeout", ["run", "--json", "--idle-timeout", String(IDLE_SEC), "hello"], {}],
      ["STEAK_DSH_IDLE_TIMEOUT_SEC", ["run", "--json", "hello"], { [IDLE_TIMEOUT_ENV]: String(IDLE_SEC) }],
    ]) {
      const res = runWith(args, extraEnv);
      assert.equal(res.status, IDLE_TIMEOUT_EXIT_CODE, `${label}: exit code 124 (stderr: ${res.stderr})`);
      assert.match(res.stderr, /stalled-stream/, `${label}: stderr names stalled-stream`);
      const events = res.stdout.trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(events[0].type, "session");
      const errEv = events.find((e) => e.type === "error");
      const finalEv = events.at(-1);
      assert.equal(errEv?.code, "stalled-stream", `${label}: emits error event`);
      assert.equal(errEv?.cause, "stalled-stream");
      assert.equal(errEv?.sessionId, "sess-stall-1");
      assert.equal(finalEv?.type, "final");
      assert.equal(finalEv?.reason?.kind, "error");
      assert.equal(finalEv?.reason?.cause, "stalled-stream");
      assert.equal(finalEv?.reason?.error?.code, "stalled-stream");
      assert.equal(finalEv?.sessionId, "sess-stall-1");
      const pids = JSON.parse(readFileSync(pidFile, "utf8"));
      assert.equal(alive(pids.child), false, `${label}: child process is gone`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idle timeout: partial stdout line without trailing newline still emits clean valid NDJSON stalled-stream lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-idle-partial-"));
  try {
    const fake = makeFakeDsh(dir);
    let out = "", err = "";
    const prevMode = process.env.FAKE_MODE;
    process.env.FAKE_MODE = "partial-line-stall";
    try {
      const code = await runCommand(
        { json: true, idleTimeoutSec: IDLE_SEC, permission: "danger-full-access", approvalPolicy: "never", addDirs: [], ownedPaths: [], patches: [], stock: true },
        ["task"],
        { root, bin: fake, killGraceMs: 250, stdout: { write: (d) => { out += String(d); } }, stderr: { write: (d) => { err += String(d); } } },
      );
      assert.equal(code, IDLE_TIMEOUT_EXIT_CODE);
    } finally {
      if (prevMode === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = prevMode;
    }
    const lines = out.trim().split("\n");
    const errEv = JSON.parse(lines.at(-2));
    const finalEv = JSON.parse(lines.at(-1));
    assert.equal(errEv.type, "error");
    assert.equal(errEv.cause, "stalled-stream");
    assert.equal(finalEv.type, "final");
    assert.equal(finalEv.reason.cause, "stalled-stream");
    assert.match(err, /stalled-stream/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idle timeout: SIGTERM -> grace SIGKILL reaps stubborn child AND stubborn grandchildren with zero leaked orphans", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-idle-group-"));
  try {
    const fake = makeFakeDsh(dir);
    for (const mode of ["stubborn-group", "child-exits-grandchild-stubborn"]) {
      const pidFile = join(dir, `pids-${mode}.json`);
      let out = "", err = "";
      const prevMode = process.env.FAKE_MODE;
      const prevPid = process.env.FAKE_PID_FILE;
      process.env.FAKE_MODE = mode;
      process.env.FAKE_PID_FILE = pidFile;
      try {
        const started = Date.now();
        const code = await runCommand(
          { json: true, idleTimeoutSec: IDLE_SEC, permission: "danger-full-access", approvalPolicy: "never", addDirs: [], ownedPaths: [], patches: [], stock: true },
          ["task"],
          { root, bin: fake, killGraceMs: 300, stdout: { write: (d) => { out += String(d); } }, stderr: { write: (d) => { err += String(d); } } },
        );
        const elapsed = Date.now() - started;
        assert.equal(code, IDLE_TIMEOUT_EXIT_CODE, `${mode}: exit 124`);
        assert.ok(elapsed >= IDLE_MS + 300, `${mode}: waited idle timeout + grace before SIGKILL (elapsed ${elapsed}ms)`);
      } finally {
        if (prevMode === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = prevMode;
        if (prevPid === undefined) delete process.env.FAKE_PID_FILE; else process.env.FAKE_PID_FILE = prevPid;
      }
      assert.ok(existsSync(pidFile), `${mode}: fake dsh recorded pids`);
      const pids = JSON.parse(readFileSync(pidFile, "utf8"));
      assert.equal(alive(pids.child), false, `${mode}: child ${pids.child} must be dead`);
      assert.equal(alive(pids.grandchild), false, `${mode}: grandchild ${pids.grandchild} must be dead (no leaked orphan)`);
      assert.match(err, /stalled-stream/);
      const finalEv = JSON.parse(out.trim().split("\n").at(-1));
      assert.equal(finalEv.reason.cause, "stalled-stream");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idle timeout pauses while a tool_call awaits its tool_result, and resumes once all open tool calls finish", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-idle-tool-"));
  try {
    const fake = makeFakeDsh(dir);

    // 1. Single tool call silent for longer than the idle timeout completes cleanly with exit 0.
    const okRes = spawnSync(process.execPath, [launcher, "run", "--json", "--idle-timeout", String(IDLE_SEC), "run long tool"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, STEAK_DSH_DSH_BIN: fake, FAKE_MODE: "tool-pause-completes", FAKE_TOOL_MS: String(IDLE_MS + 1000), DSH_HOME: join(dir, "home") },
    });
    assert.equal(okRes.status, 0, `long tool must not trigger idle timeout (stderr: ${okRes.stderr})`);
    assert.doesNotMatch(okRes.stderr, /stalled-stream/);
    const okEvents = okRes.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(okEvents.at(-1)?.type, "final");
    assert.equal(okEvents.at(-1)?.reason?.kind, "completed");

    // 2. Two parallel tool calls: watchdog stays paused while c2 is still open, then triggers once c2 closes and stream stalls.
    const parRes = spawnSync(process.execPath, [launcher, "run", "--json", "--idle-timeout", String(IDLE_SEC), "parallel tools"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, STEAK_DSH_DSH_BIN: fake, FAKE_MODE: "parallel-tools-then-stall", FAKE_TOOL_MS: String(IDLE_MS + 1000), DSH_HOME: join(dir, "home") },
    });
    assert.equal(parRes.status, IDLE_TIMEOUT_EXIT_CODE, `stalls after both tools close (stderr: ${parRes.stderr})`);
    const parEvents = parRes.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(parEvents.some((e) => e.type === "tool_result" && e.callId === "c2"), "watchdog stayed paused until c2 tool_result arrived");
    assert.equal(parEvents.at(-1)?.reason?.cause, "stalled-stream");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idle timeout: when dsh exits 0 while a descendant still holds stdout open, returns 0 with no false stalled-stream and cleans up the descendant", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-idle-holder-"));
  try {
    const fake = makeFakeDsh(dir);
    for (const mode of ["exit-with-stdout-holder", "exit-with-stubborn-stdout-holder"]) {
      const pidFile = join(dir, `pids-${mode}.json`);
      let out = "", err = "";
      const prevMode = process.env.FAKE_MODE;
      const prevPid = process.env.FAKE_PID_FILE;
      process.env.FAKE_MODE = mode;
      process.env.FAKE_PID_FILE = pidFile;
      try {
        // killGraceMs exceeds idleTimeoutSec so a stubborn stdout holder outlives the idle window;
        // proving dsh's exit stops the idle watchdog instead of emitting a false stalled-stream.
        const started = Date.now();
        const code = await runCommand(
          { json: true, idleTimeoutSec: IDLE_SEC, permission: "danger-full-access", approvalPolicy: "never", addDirs: [], ownedPaths: [], patches: [], stock: true },
          ["task"],
          { root, bin: fake, killGraceMs: IDLE_MS + 500, stdout: { write: (d) => { out += String(d); } }, stderr: { write: (d) => { err += String(d); } } },
        );
        const elapsed = Date.now() - started;
        assert.equal(code, 0, `${mode}: preserves dsh's real exit 0 (stderr: ${err})`);
        if (mode === "exit-with-stubborn-stdout-holder") {
          assert.ok(elapsed >= IDLE_MS + 500, `${mode}: waited for grace period before SIGKILL (elapsed ${elapsed}ms)`);
        }
      } finally {
        if (prevMode === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = prevMode;
        if (prevPid === undefined) delete process.env.FAKE_PID_FILE; else process.env.FAKE_PID_FILE = prevPid;
      }
      assert.doesNotMatch(err, /stalled-stream/, `${mode}: never emits false stalled-stream`);
      const events = out.trim().split("\n").map((line) => JSON.parse(line));
      const finals = events.filter((e) => e.type === "final");
      assert.equal(finals.length, 1, `${mode}: exactly one real final event`);
      assert.equal(finals[0].reason.kind, "completed");
      const pids = JSON.parse(readFileSync(pidFile, "utf8"));
      const waitDeadline = Date.now() + 2000;
      while (alive(pids.holder) && Date.now() < waitDeadline) await new Promise((r) => setTimeout(r, 20));
      assert.equal(alive(pids.holder), false, `${mode}: stdout-holding descendant ${pids.holder} was cleaned up`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idle timeout: a slow-reading stdout consumer pauses the idle timer and receives all output (including final) without false stall or truncation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-idle-slow-"));
  try {
    const fake = makeFakeDsh(dir);
    let captured = "";
    let backpressured = false;
    let writes = 0;
    let longestWriteMs = 0;
    const slowStdout = new Writable({
      highWaterMark: 16,
      write(chunk, _enc, cb) {
        captured += chunk.toString("utf8");
        backpressured = true;
        // The first write alone blocks longer than the idle timeout (however the pipe coalesces chunks), so a watchdog
        // that kept running under backpressure would fire; later writes stay slow enough to keep the stream paused.
        const delay = writes++ === 0 ? IDLE_MS + 400 : 100;
        const started = Date.now();
        setTimeout(() => { longestWriteMs = Math.max(longestWriteMs, Date.now() - started); cb(); }, delay);
      },
    });
    let err = "";
    const prevMode = process.env.FAKE_MODE;
    process.env.FAKE_MODE = "slow-consumer-burst";
    try {
      const code = await runCommand(
        { json: true, idleTimeoutSec: IDLE_SEC, permission: "danger-full-access", approvalPolicy: "never", addDirs: [], ownedPaths: [], patches: [], stock: true },
        ["task"],
        { root, bin: fake, killGraceMs: 250, stdout: slowStdout, stderr: { write: (d) => { err += String(d); } } },
      );
      assert.equal(code, 0, `slow consumer completes cleanly with exit 0 (stderr: ${err})`);
    } finally {
      if (prevMode === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = prevMode;
    }
    assert.equal(backpressured, true, "slow stdout actually exercised backpressure");
    assert.ok(longestWriteMs > IDLE_MS, `one consumer write blocked longer than the idle timeout (${longestWriteMs} ms)`);
    assert.doesNotMatch(err, /stalled-stream/, "backpressure must not trigger a false stalled-stream");
    const events = captured.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.filter((e) => e.type === "text").length, 8, "all 8 text chunks arrived without truncation");
    assert.equal(events.at(-1)?.type, "final");
    assert.equal(events.at(-1)?.text, "all-delivered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idle timeout: stdout EPIPE stops the child process group cleanly without crashing unhandled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-idle-epipe-"));
  try {
    const fake = makeFakeDsh(dir);
    const pidFile = join(dir, "pids.json");
    const child = spawn(process.execPath, [launcher, "run", "--json", "--idle-timeout", "5", "stream"], {
      cwd: dir,
      env: { ...process.env, STEAK_DSH_DSH_BIN: fake, FAKE_MODE: "epipe-spam", FAKE_PID_FILE: pidFile, DSH_HOME: join(dir, "home") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c; });
    await new Promise((resolve) => {
      child.stdout.once("data", () => {
        child.stdout.destroy();
        resolve();
      });
    });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("timed out waiting for EPIPE exit")); }, 10_000);
      child.on("close", (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.notEqual(code, 0, `exits non-zero on EPIPE (got ${code})`);
    assert.doesNotMatch(stderr, /Unhandled 'error' event|ERR_UNHANDLED_ERROR/, `no unhandled EPIPE crash: ${stderr}`);
    if (existsSync(pidFile)) {
      const pids = JSON.parse(readFileSync(pidFile, "utf8"));
      assert.equal(alive(pids.child), false, `dsh child ${pids.child} was terminated on EPIPE`);
      assert.equal(alive(pids.grandchild), false, `grandchild ${pids.grandchild} was terminated on EPIPE`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
