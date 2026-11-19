// A quiet or stalled Claude Code turn: the silence limits, the quiet retry before the first byte, and the bounded process recovery.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeClaudeProcesses, runClaudeRequest } from "../claude-code/claude-cli.js";
import { effortRank, formatSilence, idleLimits, requestShape } from "../claude-code/idle-policy.js";

// Caller budget below. Old limit: 1 000 ms of silence anywhere. New: 1 400 ms mid-stream, 300 ms to the first byte (then a quiet retry).
const BUDGET = 1_000;

const FAKE = `#!/usr/bin/env node
import readline from "node:readline";
import { appendFileSync } from "node:fs";
if (process.argv.includes("auth")) { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
appendFileSync(process.env.SPAWNS, process.pid + "\\n");
const usage = { input_tokens: 1, output_tokens: 1 };
const history = [];
for await (const line of readline.createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === "user" || frame.type === "assistant") history.push(frame.message);
  if (frame.shouldQuery === false) { console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 0, usage })); continue; }
  if (frame.type !== "user") continue;
  try { await (await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", body: JSON.stringify({ messages: history }) })).text(); } catch {}
  console.log(JSON.stringify({ type: "assistant", message: { id: "m", role: "assistant", content: [{ type: "text", text: "answer" }], stop_reason: "end_turn", usage } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, usage }));
}
`;

const timers = new Set();
const later = (ms, fn) => { const t = setTimeout(fn, ms); timers.add(t); };
const sse = (response, ...events) => { for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); };
const START = { type: "message_start", message: { id: "m", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 1 } } };
const textStart = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
const textDelta = (text) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const FINISH = [{ type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" }];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function rig(behaviour, body) {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-recovery-"));
  const executable = join(dir, "claude.mjs");
  const spawns = join(dir, "spawns.log");
  writeFileSync(executable, FAKE); chmodSync(executable, 0o755); writeFileSync(spawns, "");
  execFileSync(executable, ["auth", "status"]); // first launch of a new executable is scanned by the OS: keep it out of the timed call
  const bodies = [];
  let attempts = 0;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    bodies.push(Buffer.concat(chunks).toString("utf8"));
    attempts += 1;
    const stop = behaviour(attempts, response);
    response.on("close", () => stop?.());
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = upstream.address().port;
  try {
    await body({
      bodies,
      attempts: () => attempts,
      pids: () => readFileSync(spawns, "utf8").split("\n").filter(Boolean).map(Number),
      run: (extra = {}, env = {}) => {
        const events = [];
        return runClaudeRequest({
          model: "default", cwd: dir, systemPrompt: "s", manifest: [], extraBody: {}, toolNames: new Set(),
          frames: [{ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } }],
          timeoutMs: BUDGET, upstreamUrl: `http://127.0.0.1:${port}`, onEvent: (event) => events.push(event),
          env: { STEAK_DSH_CLAUDE_CODE_COMMAND: executable, SPAWNS: spawns, ...env }, ...extra,
        }).then((output) => ({ output, events }), (error) => Promise.reject(Object.assign(error, { events })));
      },
    });
  } finally {
    await closeClaudeProcesses();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a healthy turn silent longer than the old limit still completes", () => rig((_attempt, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, START, textStart, textDelta("answer"));
  later(1_200, () => { sse(response, ...FINISH); response.end(); }); // 1.2 s of nothing: over the old 1.0 s, under the new 1.4 s
}, async (r) => {
  const { output } = await r.run();
  assert.equal(output.message.stop_reason, "end_turn");
  assert.equal(r.attempts(), 1);
  assert.equal(r.pids().length, 1);
}));

test("a connection that never answers is retried quietly without restarting Claude Code", () => rig((attempt, response) => {
  if (attempt === 1) return; // no headers, no bytes
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, START, textStart, textDelta("answer"), ...FINISH);
  response.end();
}, async (r) => {
  const started = Date.now();
  const { output } = await r.run();
  assert.equal(output.message.stop_reason, "end_turn");
  assert.equal(r.attempts(), 2);
  assert.equal(r.pids().length, 1, "the same process served both attempts");
  assert.ok(Date.now() - started < 2_500, "recovered at the 300 ms first-byte limit, not the full budget");
}));

test("a reply that stalls before any content reached the harness: only that child is stopped and the turn is asked again once", () => rig((attempt, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (attempt === 1) { sse(response, START); return; } // then silence
  sse(response, START, textStart, textDelta("answer"), ...FINISH);
  response.end();
}, async (r) => {
  const { output } = await r.run({ canRestart: () => true });
  assert.equal(output.message.stop_reason, "end_turn");
  assert.equal(r.attempts(), 2);
  const pids = r.pids();
  assert.equal(pids.length, 2);
  assert.equal(alive(pids[0]), false, "the stalled child was stopped");
  assert.equal(r.bodies[0], r.bodies[1], "the replayed request is identical: nothing added, nothing run twice");
}));

test("a stall after content reached the harness is not restarted (it could not be taken back) and says why", () => rig((_attempt, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, START, textStart, textDelta("answer"));
}, async (r) => {
  await assert.rejects(r.run({ canRestart: () => false }), (error) => {
    assert.equal(error.code, "CLAUDE_CODE_WAIT_LIMIT");
    assert.match(error.message, /part of the reply had already been handed to the harness/);
    return true;
  });
  assert.equal(r.attempts(), 1);
}));

test("a stream that goes quiet on every attempt: two recoveries, then an error that names the cause", () => rig((_attempt, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, START, { type: "ping" });
}, async (r) => {
  await assert.rejects(r.run({ canRestart: () => true }), (error) => {
    assert.equal(error.code, "CLAUDE_CODE_WAIT_LIMIT");
    assert.match(error.message, /^Claude Code stream idle limit exceeded \(no bytes or events\): silent for \d+ s partway through the reply; last event: ping; the Claude Code process was alive/);
    assert.match(error.message, /2 automatic recoveries tried/);
    assert.match(error.message, /STEAK_DSH_CLAUDE_CODE_IDLE_LIMIT_MS/);
    return true;
  });
  assert.equal(r.attempts(), 3, "the first try plus two recoveries, never more");
  for (const pid of r.pids()) assert.equal(alive(pid), false);
}));

test("recovery can be switched off from the environment", () => rig((_attempt, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, START);
}, async (r) => {
  await assert.rejects(r.run({ canRestart: () => true }, { STEAK_DSH_CLAUDE_CODE_MAX_RECOVERIES: "0" }), /automatic recovery is off \(STEAK_DSH_CLAUDE_CODE_MAX_RECOVERIES=0\)/);
  assert.equal(r.attempts(), 1);
}));

test("the silence limits scale with effort and context, are longer than the old budget, and read the environment", () => {
  const base = idleLimits(300_000, {}, {});
  assert.equal(base.streamIdleMs, 420_000);
  assert.equal(base.firstByteMs, 90_000);
  const high = idleLimits(300_000, { effort: "high", bodyBytes: 1_575_000 }, {});
  assert.ok(high.streamIdleMs > base.streamIdleMs && high.streamIdleMs <= 540_000);
  assert.ok(high.firstByteMs > base.firstByteMs && high.firstByteMs <= high.streamIdleMs);
  assert.equal(idleLimits(300_000, {}, { STEAK_DSH_CLAUDE_CODE_IDLE_LIMIT_MS: "900000" }).streamIdleMs, 900_000);
  assert.equal(idleLimits(300_000, {}, { STEAK_DSH_CLAUDE_CODE_MAX_RECOVERIES: "0" }).maxRecoveries, 0);
  assert.throws(() => idleLimits(300_000, {}, { STEAK_DSH_CLAUDE_CODE_IDLE_LIMIT_MS: "-1" }), /positive number/);
  assert.equal(effortRank({ thinkingBudgetTokens: 40_000 }), 4);
  const raw = Buffer.from('{"output_config":{"effort":"high"}}');
  assert.deepEqual(requestShape(raw), { bodyBytes: raw.length, effort: "high" });
  assert.equal(formatSilence(301_400), "5 min 1 s");
});

test("the plugin turns its operator config into the route's limits", async () => {
  const src = readFileSync(new URL("../claude-code/plugin.js", import.meta.url), "utf8");
  for (const key of ["idleLimitMs", "firstByteLimitMs", "maxRecoveries"]) assert.match(src, new RegExp(key));
});
