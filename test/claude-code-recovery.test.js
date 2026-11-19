// A quiet or stalled Claude Code turn: the silence limits, the quiet retry before the first byte, and the bounded process recovery.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeClaudeProcesses, runClaudeRequest, setClaudeCodeDiagnosticReporter } from "../claude-code/claude-cli.js";
import { createClaudeCodeAdapter } from "../claude-code/adapter.js";
import { harness, request, system, user } from "./cc-helpers.js";
import { effortRank, formatSilence, idleLimits, MAX_REQUEST_SENDS, requestShape } from "../claude-code/idle-policy.js";

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
  if (process.env.HANG_AFTER_REPLY) await new Promise(() => setInterval(() => {}, 1000));
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
      /** The same turn through the real createClaudeCodeAdapter wiring: returns every chunk the harness would receive. */
      stream: async (env = {}, signal, tools = []) => {
        const adapter = createClaudeCodeAdapter(harness, {
          env: () => ({ PATH: process.env.PATH, HOME: process.env.HOME, STEAK_DSH_CLAUDE_CODE_COMMAND: executable, SPAWNS: spawns, ...env }),
          timeoutMs: BUDGET, upstreamUrl: `http://127.0.0.1:${port}`,
        });
        const chunks = [];
        try {
          for await (const chunk of adapter.stream(request([user("hello")], { signal, tools, sessionId: `s-${Math.random()}` }))) chunks.push(chunk);
          return { chunks };
        } catch (error) {
          throw Object.assign(error, { chunks });
        }
      },
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
  assert.throws(() => idleLimits(300_000, {}, { STEAK_DSH_CLAUDE_CODE_IDLE_LIMIT_MS: "-1" }), /STEAK_DSH_CLAUDE_CODE_IDLE_LIMIT_MS must be a number of milliseconds from 1000/);
  assert.throws(() => idleLimits(300_000, {}, { STEAK_DSH_CLAUDE_CODE_MAX_RECOVERIES: "3" }), /0 to 2/);
  assert.equal(idleLimits(300_000, {}, {}).maxSends, MAX_REQUEST_SENDS);
  assert.equal(MAX_REQUEST_SENDS, 3);
  assert.equal(effortRank({ thinkingBudgetTokens: 40_000 }), 4);
  const raw = Buffer.from('{"output_config":{"effort":"high"}}');
  assert.deepEqual(requestShape(raw), { bodyBytes: raw.length, effort: "high" });
  assert.equal(formatSilence(301_400), "5 min 1 s");
});


// ---- review fixes ---------------------------------------------------------------------------------------------------

test("env limits are checked after rounding, floored at 1000 ms and capped at the largest timer", () => {
  for (const bad of ["0.3", "0", "-5", "999", "999.4", "abc", "NaN", "Infinity", "2147483648", "1e12"]) {
    assert.throws(() => idleLimits(180_000, {}, { STEAK_DSH_CLAUDE_CODE_IDLE_LIMIT_MS: bad }), /STEAK_DSH_CLAUDE_CODE_IDLE_LIMIT_MS must be a number of milliseconds/, bad);
    assert.throws(() => idleLimits(180_000, {}, { STEAK_DSH_CLAUDE_CODE_FIRST_BYTE_LIMIT_MS: bad }), /STEAK_DSH_CLAUDE_CODE_FIRST_BYTE_LIMIT_MS must be/, bad);
  }
  assert.equal(idleLimits(180_000, {}, { STEAK_DSH_CLAUDE_CODE_IDLE_LIMIT_MS: "1000.4" }).streamIdleMs, 1_000);
  assert.equal(idleLimits(180_000, {}, { STEAK_DSH_CLAUDE_CODE_IDLE_LIMIT_MS: "999.6" }).streamIdleMs, 1_000);
  const huge = idleLimits(180_000, {}, { STEAK_DSH_CLAUDE_CODE_IDLE_LIMIT_MS: "2147483647" });
  assert.equal(huge.queueIdleMs, 2_147_483_647, "the native queue limit never exceeds Node's timer maximum");
  assert.ok(idleLimits(2_147_483_647, {}, {}).queueIdleMs <= 2_147_483_647);
});

test("a bad limit fails the request by name before any Claude Code process is started", () => rig(() => { throw new Error("the API must not be called"); }, async (r) => {
  await assert.rejects(r.run({ canRestart: () => true }, { STEAK_DSH_CLAUDE_CODE_IDLE_LIMIT_MS: "0.3" }), /STEAK_DSH_CLAUDE_CODE_IDLE_LIMIT_MS must be a number of milliseconds from 1000/);
  assert.equal(r.pids().length, 0, "no process was acquired, so none is left busy");
  assert.equal(r.attempts(), 0);
}));

test("with onEvent set and no canRestart, events count as delivered: no recovery, the named error", () => rig((_attempt, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, START); // not even a content block: the default must still be 'delivered'
}, async (r) => {
  await assert.rejects(r.run(), (error) => {
    assert.match(error.message, /already been handed to the harness and cannot be taken back/);
    return true;
  });
  assert.equal(r.attempts(), 1);
  assert.equal(r.pids().length, 1);
}));

test("without onEvent nothing can have been delivered: a quiet stall is recovered", () => rig((attempt, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (attempt === 1) { sse(response, START); return; }
  sse(response, START, textStart, textDelta("answer"), ...FINISH);
  response.end();
}, async (r) => {
  const { output } = await r.run({ onEvent: undefined });
  assert.equal(output.message.stop_reason, "end_turn");
  assert.equal(r.attempts(), 2);
}));

test("through the real adapter: a stall before any content is recovered and the harness sees the answer once", () => rig((attempt, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (attempt === 1) { sse(response, START, { type: "ping" }); return; }
  sse(response, START, textStart, textDelta("answer"), ...FINISH);
  response.end();
}, async (r) => {
  const { chunks } = await r.stream();
  const kinds = chunks.map((chunk) => chunk.type);
  assert.equal(kinds.filter((kind) => kind === "block-start").length, 1, `chunks: ${kinds.join(",")}`);
  assert.equal(chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.text).join(""), "answer");
  assert.equal(r.attempts(), 2);
  assert.equal(r.pids().length, 2);
}));

test("through the real adapter: a stall after text reached the harness is not restarted and the text is shown once", () => rig((_attempt, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, START, textStart, textDelta("answer"), { type: "ping" });
}, async (r) => {
  await assert.rejects(r.stream(), (error) => {
    assert.match(error.message, /cannot be taken back/);
    const texts = error.chunks.filter((chunk) => chunk.type === "text-delta");
    assert.equal(texts.length, 1, `chunks: ${error.chunks.map((chunk) => chunk.type).join(",")}`);
    assert.equal(error.chunks.filter((chunk) => chunk.type === "block-start").length, 1);
    return true;
  });
  assert.equal(r.attempts(), 1);
  assert.equal(r.pids().length, 1);
  for (const pid of r.pids()) assert.equal(alive(pid), false);
}));

test("message_stop and then Claude Code hangs: the turn finishes from the received reply and the API is asked once", () => rig((_attempt, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, START, textStart, textDelta("answer"), ...FINISH);
  response.end();
}, async (r) => {
  const lines = [];
  setClaudeCodeDiagnosticReporter((line) => lines.push(line));
  const { output } = await r.run({ canRestart: () => true }, { HANG_AFTER_REPLY: "1" });
  assert.equal(output.message.stop_reason, "end_turn");
  assert.equal(output.message.content[0].text, "answer");
  assert.equal(output.hung, true);
  assert.equal(r.attempts(), 1, "a complete reply is never paid for twice");
  const pids = r.pids();
  assert.equal(pids.length, 1);
  assert.equal(alive(pids[0]), false, "the hung process was dropped, not reused");
  assert.ok(lines.some((line) => /whole reply/.test(line)), JSON.stringify(lines));
}));

test("hangs after message_stop: usage, tool arguments and stop reason the harness sees come from the relay's capture", () => rig((_attempt, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(
    response,
    START,
    textStart, textDelta("let me "), textDelta("look"), { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__dsh__lookup", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"query\":\"ab" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "c\",\"limit\"" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ":3}" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  );
  response.end();
}, async (r) => {
  const tool = { name: "lookup", description: "look something up", parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } } } };
  const { chunks } = await r.stream({ HANG_AFTER_REPLY: "1" }, undefined, [tool]);
  const kinds = chunks.map((chunk) => chunk.type).join(",");
  const call = chunks.find((chunk) => chunk.type === "block-end" && chunk.block.type === "tool-call")?.block;
  assert.ok(call, `chunks: ${kinds}`);
  assert.deepEqual({ name: call.name, arguments: JSON.parse(call.arguments) }, { name: "lookup", arguments: { query: "abc", limit: 3 } });
  assert.equal(chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.text).join(""), "let me look");
  const usage = chunks.find((chunk) => chunk.type === "usage").usage;
  assert.equal(usage.inputTokens, 1);
  assert.equal(usage.outputTokens, 7, "message_delta's count replaces message_start's 1");
  assert.deepEqual(chunks.at(-1).reason, { kind: "tool-calls" });
  assert.equal(r.attempts(), 1);
  for (const pid of r.pids()) assert.equal(alive(pid), false);
}));

test("canRestart is asked again right before the restart: output that arrived during the backoff ends the turn, no second send", () => rig((_attempt, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, START, { type: "ping" }); // first byte, then silence
}, async (r) => {
  let asked = 0;
  await assert.rejects(r.run({ canRestart: () => (asked += 1) === 1 }), /cannot be taken back/); // true at the stall, false after the backoff and acquisition
  assert.equal(asked, 2, "asked at the stall and again right before the restart");
  assert.equal(r.attempts(), 1, "the request was not sent again");
  for (const pid of r.pids()) assert.equal(alive(pid), false, "no process is left running");
}));

test("one request is sent at most 3 times across both retry layers: a connection that never answers", () => rig(() => { /* never answers */ }, async (r) => {
  await assert.rejects(r.run({ canRestart: () => true }), /already sent 3 times, the most one request is ever sent \(3\)/);
  assert.equal(r.attempts(), MAX_REQUEST_SENDS, "was up to 9 (3 relay attempts x 3 processes)");
}));

test("sends are shared: one quiet retry, one recovery, then no more", () => rig((attempt, response) => {
  if (attempt === 1) return;
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (attempt === 2) { sse(response, START, { type: "ping" }); return; }
  sse(response, START, textStart, textDelta("answer"), ...FINISH);
  response.end();
}, async (r) => {
  const { output } = await r.run({ canRestart: () => true });
  assert.equal(output.message.stop_reason, "end_turn");
  assert.equal(r.attempts(), 3);
  assert.equal(r.pids().length, 2);
}));

test("sends are shared: with two sends spent, a fresh process gets exactly one more", () => rig((attempt, response) => {
  if (attempt === 1) return;
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, START, { type: "ping" });
}, async (r) => {
  await assert.rejects(r.run({ canRestart: () => true }), /stream idle limit exceeded/);
  assert.equal(r.attempts(), 3, "never a fourth send");
}));

test("Escape during the backoff between recoveries stops the turn: no further request, no leftover child", () => rig((_attempt, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, START, { type: "ping" });
}, async (r) => {
  const controller = new AbortController();
  setClaudeCodeDiagnosticReporter((line) => { if (/asking again/.test(line)) controller.abort(new Error("operator pressed Escape")); });
  await assert.rejects(r.run({ canRestart: () => true, signal: controller.signal }), /operator pressed Escape/);
  assert.equal(r.attempts(), 1, "no second request after Escape");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(r.pids().length, 1, "no replacement process was started");
  for (const pid of r.pids()) assert.equal(alive(pid), false);
}));

test("Escape during a quiet stretch is an abort, not a stall, and nothing is recovered", () => rig((_attempt, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, START, { type: "ping" });
}, async (r) => {
  const controller = new AbortController();
  later(500, () => controller.abort(new Error("operator pressed Escape")));
  const started = Date.now();
  await assert.rejects(r.run({ canRestart: () => true, signal: controller.signal }), (error) => {
    assert.match(error.message, /operator pressed Escape/);
    assert.doesNotMatch(error.message, /stream idle limit exceeded/);
    return true;
  });
  assert.ok(Date.now() - started < 1_300, "ended at Escape, before the 1.4 s stall limit");
  assert.equal(r.attempts(), 1);
  assert.equal(r.pids().length, 1);
}));

// ---- the plugin's own config, run for real (apply() is called and the environment its adapter hands the CLI is read) ----

const ENV_PROBE = `#!/usr/bin/env node
import readline from "node:readline";
import { appendFileSync } from "node:fs";
if (process.argv.includes("auth")) { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
const usage = { input_tokens: 1, output_tokens: 1 };
for await (const line of readline.createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type !== "user") continue;
  appendFileSync(process.env.PROBE_LOG, JSON.stringify({
    idle: process.env.STEAK_DSH_CLAUDE_CODE_IDLE_LIMIT_MS, first: process.env.STEAK_DSH_CLAUDE_CODE_FIRST_BYTE_LIMIT_MS, recoveries: process.env.STEAK_DSH_CLAUDE_CODE_MAX_RECOVERIES,
  }) + "\\n");
  console.log(JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }));
  console.log(JSON.stringify({ type: "assistant", message: { id: "m", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, usage }));
}
`;

async function applyPlugin(config) {
  const plugin = await import("../claude-code/plugin.js");
  let adapter;
  let dispose;
  const ctx = { llm: { registerAdapter: (_ids, registered) => { adapter = registered; return () => {}; } }, effect: (fn) => { dispose = fn(); } };
  plugin.apply(ctx, config);
  return { adapter, close: async () => { dispose?.(); await adapter?.close(); } };
}

test("plugin apply(): operator config reaches the CLI as the route's limits, rounded and validated at runtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-plugin-"));
  const executable = join(dir, "claude.mjs");
  const log = join(dir, "probe.log");
  writeFileSync(executable, ENV_PROBE); chmodSync(executable, 0o755); writeFileSync(log, "");
  execFileSync(executable, ["auth", "status"]);
  process.env.PROBE_LOG = log;
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) if (name.startsWith("STEAK_DSH_CLAUDE_CODE_")) delete process.env[name];
  let applied;
  try {
    applied = await applyPlugin({ command: executable, idleLimitMs: 250_000.4, firstByteLimitMs: 60_000, maxRecoveries: 1 });
    const chunks = [];
    for await (const chunk of applied.adapter.stream(request([user("hello")], { sessionId: "plugin-probe" }))) chunks.push(chunk);
    const seen = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1));
    assert.deepEqual(seen, { idle: "250000", first: "60000", recoveries: "1" });
    // an explicit environment value wins over the config, as documented
    process.env.STEAK_DSH_CLAUDE_CODE_MAX_RECOVERIES = "2";
    for await (const chunk of applied.adapter.stream(request([user("again")], { sessionId: "plugin-probe-2" }))) chunks.push(chunk);
    assert.equal(JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)).recoveries, "2");
    // an EMPTY or blank variable counts as unset: it must not override the valid config value
    for (const [index, blank] of ["", "   "].entries()) {
      for (const name of ["IDLE_LIMIT_MS", "FIRST_BYTE_LIMIT_MS", "MAX_RECOVERIES"]) process.env[`STEAK_DSH_CLAUDE_CODE_${name}`] = blank;
      for await (const chunk of applied.adapter.stream(request([user("blank")], { sessionId: `plugin-probe-blank-${index}` }))) chunks.push(chunk);
      assert.deepEqual(JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)), { idle: "250000", first: "60000", recoveries: "1" }, `blank ${JSON.stringify(blank)}`);
    }
  } finally {
    await applied?.close();
    await closeClaudeProcesses();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
  // bad config is a named error when the plugin is applied, never a silent default
  await assert.rejects(applyPlugin({ idleLimitMs: 0.3 }), /idleLimitMs must be a number of milliseconds from 1000/);
  await assert.rejects(applyPlugin({ firstByteLimitMs: 2_147_483_648 }), /firstByteLimitMs must be a number of milliseconds/);
  await assert.rejects(applyPlugin({ maxRecoveries: 3 }), /maxRecoveries must be a whole number from 0 to 2/);
  await assert.rejects(applyPlugin({ idleLimitMs: "soon" }), /idleLimitMs must be/);
});
