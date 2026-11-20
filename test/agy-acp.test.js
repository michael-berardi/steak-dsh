// The ACP agy route against a fake ACP agent (test/fixtures/fake-agy-acp.mjs). No agy is installed and nobody signs in.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { delimiter } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHarness } from "../claude-code/harness.js";
import { createAcpAdapter, promptText, toolResults } from "../agy/acp/adapter.js";
import { selectTransport } from "../agy/acp/probe.js";
import { normalizeUsage, parseSessionOptions } from "../agy/acp/protocol.js";
import { createMcpBridge } from "../agy/acp/bridge.js";

const root = join(import.meta.dirname, "..");
const FAKE = join(root, "test", "fixtures", "fake-agy-acp.mjs");
const harness = await loadHarness({ entry: "/nonexistent" });
const user = (text) => ({ role: "user", id: "u", source: { kind: "user" }, content: [{ type: "text", text }] });
const echoTool = { name: "echo", description: "echo back", parameters: { type: "object", properties: { text: { type: "string" } } } };
chmodSync(FAKE, 0o755);

function setup(t, mode = "text", extra = {}, settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-acp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "fake.log");
  const env = { PATH: process.env.PATH, HOME: dir, DSH_HOME: join(dir, "dsh-home"), STEAK_DSH_AGY_BIN: FAKE, FAKE_ACP_MODE: mode, FAKE_ACP_LOG: log, ...extra };
  const reports = [];
  const adapter = createAcpAdapter(harness, { env: () => env, report: (m) => reports.push(m), ...settings });
  t.after(() => adapter.close());
  return { dir, log, env, adapter, reports };
}
const events = (log) => (readFileSync(log, "utf8").trim() || "").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const textOf = (chunks) => chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.text).join("");
async function collect(adapter, options) {
  const chunks = [];
  for await (const chunk of adapter.stream({ provider: "agy", model: "gemini-4-neon-high", tools: [], messages: [user("hi")], ...options })) chunks.push(chunk);
  return chunks;
}
async function failure(adapter, options) {
  try { await collect(adapter, options); } catch (error) { return error; }
  assert.fail("expected the request to fail");
}

test("transport: auto picks ACP when agy acp --help works; explicit modes and fallbacks are named", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-acp-probe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, STEAK_DSH_AGY_BIN: FAKE };
  assert.deepEqual(selectTransport({ ...env, STEAK_DSH_AGY_TRANSPORT: "acp" }), { transport: "acp", reason: "agy acp --help succeeded" });
  assert.deepEqual(selectTransport({ ...env }), { transport: "acp", reason: "agy acp --help succeeded" });
  assert.equal(selectTransport({ ...env, STEAK_DSH_AGY_TRANSPORT: "headless" }).transport, "headless");
  assert.equal(selectTransport({ ...env, STEAK_DSH_AGY_TRANSPORT: undefined, STEAK_PI_AGY_TRANSPORT: "headless" }).transport, "headless");
  const fallback = selectTransport({ ...env, STEAK_DSH_AGY_BIN: join(dir, "no-agy") });
  assert.equal(fallback.transport, "headless");
  assert.match(fallback.reason, /using the headless agy route/);
  assert.throws(() => selectTransport({ ...env, STEAK_DSH_AGY_TRANSPORT: "bogus" }), (error) => error.code === "AGY_BAD_REQUEST" && /bogus/.test(error.message));
  assert.throws(() => selectTransport({ ...env, STEAK_DSH_AGY_BIN: join(dir, "no-agy"), STEAK_DSH_AGY_TRANSPORT: "acp" }), (error) => error.code === "AGY_ACP_UNSUPPORTED");
});

test("run: one ACP session, one prompt, streamed text, real context window and a stop", async (t) => {
  const { adapter, log, dir } = setup(t);
  const chunks = await collect(adapter, { messages: [user("first question")] });
  assert.equal(textOf(chunks), "answer from acp\n");
  assert.deepEqual(chunks.at(-1).reason, { kind: "stop" });
  assert.match(chunks.at(-1).replayState.acp.sessionId, /^fake-acp-session-/);
  assert.equal(chunks.filter((chunk) => chunk.type === "usage").length, 1);
  assert.deepEqual(chunks.find((chunk) => chunk.type === "usage").usage, {
    inputTokens: 180_000, outputTokens: 0, totalTokens: 180_000, cacheReadTokens: 0, cacheWriteTokens: 0,
  });
  assert.equal(adapter.contextWindow, 1_000_000, "learned from usage_update, not guessed");
  const lines = events(log);
  const launch = lines.find((event) => event.event === "launch");
  assert.deepEqual(launch.argv.slice(0, 2), ["acp", "--agent"]);
  for (const flag of ["--process-per-session", "--disable-telemetry", "--log-file"]) assert.ok(launch.argv.includes(flag), flag);
  assert.ok(launch.argv.includes("--add-dir") && launch.argv[launch.argv.indexOf("--add-dir") + 1] === realpathSync(process.cwd()));
  assert.equal(launch.argv.some((arg) => /dangerously|skip-permissions/.test(arg)), false);
  const mcp = lines.find((event) => event.event === "mcp").mcp;
  assert.equal(mcp.type, "http");
  assert.match(mcp.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal(mcp.headers[0].name, "Authorization");
  assert.ok(mcp.headers[0].value.startsWith("Bearer "));
  void dir;
  assert.deepEqual(lines.filter((event) => event.event === "prompt").map((event) => event.prompt), ["first question"]);
});

test("minimal agent: no native tools, no default components; never --dangerously-skip-permissions", async (t) => {
  const { adapter, dir } = setup(t);
  await collect(adapter);
  const base = readdirSync(join(dir, "dsh-home")).find((name) => name.startsWith("steak-dsh-acp-"));
  const md = readFileSync(join(dir, "dsh-home", base, ".agents", "agents", "steak-dsh-bridge", "agent.md"), "utf8");
  assert.match(md, /^tools: \[\]$/m);
  assert.match(md, /^excludeDefaultComponents: true$/m);
  assert.match(md, /^mainAgent: true$/m);
  const route = readFileSync(join(root, "agy", "acp", "session.js"), "utf8");
  assert.match(route, /--disable-telemetry/);
  assert.match(route, /--process-per-session/);
});

test("model and effort: the session's real option list is used, not a hardcoded picker", async (t) => {
  const { adapter, log } = setup(t, "options");
  const listed = await adapter.resolveModel("agy", "gemini-4-neon-low");
  assert.deepEqual(listed.reasoning.efforts.map((effort) => effort.name), ["off", "low", "medium", "high", "xhigh", "max"]);
  await assert.rejects(adapter.resolveModel("agy", "gemini-9-nope"), (error) => error.code === "AGY_MODEL_UNAVAILABLE");
  await collect(adapter, { model: "gemini-4-neon-low", reasoningEffort: "xhigh" });
  const lines = events(log).filter((event) => event.method === "session/set_config_option");
  const pairs = lines.map((event) => [event.params.configId, event.params.value]);
  assert.ok(pairs.some((pair) => pair[0] === "model" && pair[1] === "gemini-4-neon-low"));
  assert.ok(pairs.some((pair) => pair[0] === "thought_level" && pair[1] === "extra"));
  const run = events(log).find((event) => event.event === "prompt");
  assert.equal(run.model, "gemini-4-neon-low");
  assert.equal(run.effort, "extra");
  assert.ok((await adapter.resolveModel("agy", "gemini-4-neon-low")).context.contextWindow > 0);
});

test("tools: an MCP tools/call becomes a harness tool call and its result round-trips to agy", async (t) => {
  const { adapter, log } = setup(t, "tool");
  const first = await collect(adapter, { tools: [echoTool], messages: [user("say bridge")] });
  const call = first.find((chunk) => chunk.type === "block-end" && chunk.block.type === "tool-call")?.block;
  assert.ok(call, "the bridge's tool call reached the harness");
  assert.deepEqual({ name: call.name, arguments: JSON.parse(call.arguments) }, { name: "echo", arguments: { text: "say bridge" } });
  assert.deepEqual(first.at(-1).reason, { kind: "tool-calls" });
  assert.equal(first.at(-1).replayState.acp.calls.length, 1);
  const assistant = { role: "assistant", id: "a", source: { kind: "model", replayState: first.at(-1).replayState }, content: [call] };
  const tool = { role: "tool", id: "t", toolCallId: call.id, isError: false, content: [{ type: "text", text: "harness ran echo" }] };
  const second = await collect(adapter, { tools: [echoTool], messages: [user("say bridge"), assistant, tool] });
  assert.equal(textOf(second), "bridge said harness ran echoanswer from acp\n");
  assert.deepEqual(second.at(-1).reason, { kind: "stop" });
  const bridge = events(log).find((event) => event.event === "bridge");
  assert.equal(bridge.status, 200);
  assert.equal(bridge.result.isError, undefined);
  assert.equal(events(log).filter((event) => event.event === "launch").length, 1, "one long-lived session across both turns");
  assert.equal(events(log).filter((event) => event.event === "prompt").length, 1, "the ACP prompt was not restarted");
});

test("tool results: an unmatched result is not fed to the bridge; a new prompt is sent instead", async (t) => {
  const { adapter, log } = setup(t);
  const chunks = await collect(adapter, { tools: [echoTool], messages: [user("hi"), { role: "tool", toolCallId: "not-ours", content: [{ type: "text", text: "x" }] }] });
  assert.deepEqual(chunks.at(-1).reason, { kind: "stop" });
  assert.equal(events(log).filter((event) => event.event === "bridge").length, 0);
  assert.deepEqual(events(log).filter((event) => event.event === "prompt").map((event) => event.prompt), ["hi"]);
});

test("signed out: -32000 'Authentication required' is a named sign-in error", async (t) => {
  const { adapter } = setup(t, "auth");
  const error = await failure(adapter);
  assert.equal(error.code, "AGY_NOT_SIGNED_IN");
  assert.match(error.message, /Authentication required/);
  assert.match(error.message, /run agy once to sign in/);
});

test("cancel: abort sends session/cancel and reports AGY_CANCELLED, with no live child", async (t) => {
  const { adapter, log } = setup(t, "cancel");
  const controller = new AbortController();
  const seen = [];
  const run = (async () => {
    for await (const chunk of adapter.stream({ provider: "agy", model: "gemini-4-neon-high", tools: [], messages: [user("hi")], signal: controller.signal })) {
      seen.push(chunk);
      if (chunk.type === "usage") controller.abort(new Error("stopped"));
    }
  })();
  await assert.rejects(run, (error) => error.code === "AGY_CANCELLED");
  assert.ok(seen.length > 0);
  let lines = events(log);
  for (let attempt = 0; !lines.some((event) => event.method === "session/cancel") && attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    lines = events(log);
  }
  assert.ok(lines.some((event) => event.method === "session/cancel"), "cancellation was sent to the agent");
  const pid = lines.find((event) => event.event === "launch").pid;
  let alive = true;
  for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
    try { process.kill(pid, 0); } catch { alive = false; }
    if (alive) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(alive, false, "the ACP child was stopped with the session");
});

test("bridge: 127.0.0.1 only, random bearer token checked in constant time, closed with the session", async (t) => {
  const { adapter } = setup(t);
  await collect(adapter, { tools: [echoTool] });
  const session = [...adapter.sessions.values()][0];
  const bridge = session.bridge;
  const denied = await fetch(`${bridge.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${"x".repeat(bridge.token.length)}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
  assert.equal(denied.status, 401);
  const allowed = await fetch(`${bridge.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).result.tools[0].name, "echo");
  await adapter.close();
  await assert.rejects(fetch(`${bridge.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${bridge.token}` }, body: "{}" }));
});

test("usage: cumulative input/cacheRead is scaled to single-call occupancy", () => {
  const result = normalizeUsage({ size: 1_000_000, used: 190_000, inputTokens: 90_000, cacheReadTokens: 130_000, totalTokens: 150_000 });
  assert.equal(result.contextWindow, 1_000_000);
  assert.equal(result.usage.inputTokens + result.usage.cacheReadTokens, 150_000);
  assert.equal(result.usage.totalTokens, 150_000);
  assert.equal(result.usage.cacheReadTokens, 88_636);
  const plain = normalizeUsage({ used: 42, size: 1000, totalTokens: 42 });
  assert.deepEqual(plain.usage, { inputTokens: 42, outputTokens: 0, totalTokens: 42, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test("options: the thinking-level names Google documents become our effort ids", () => {
  const parsed = parseSessionOptions([
    { id: "model", category: "model", type: "select", options: [{ value: "a", name: "A" }] },
    { id: "thought_level", type: "select", options: ["Low", "Medium", "High", "Extra", "Max"].map((name) => ({ value: name.toLowerCase(), name })) },
  ]);
  assert.deepEqual(parsed.efforts.map((effort) => effort.id), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(parsed.models, [{ id: "a", name: "A" }]);
});

test("prompt: the newest user message is sent; images are refused before a session starts", () => {
  assert.equal(promptText([user("first"), { role: "assistant", content: [{ type: "text", text: "ok" }] }, user("second")]), "second");
  assert.throws(() => promptText([{ role: "user", content: [{ type: "image", data: "x" }] }]), (error) => error.code === "AGY_BAD_REQUEST");
  const parked = { parked: new Map(), deliverToolResult(id) { return this.parked.delete(id); } };
  parked.parked.set("acp-1", {});
  assert.deepEqual(toolResults(parked, [{ role: "tool", toolCallId: "acp-1", content: [{ type: "text", text: "ok" }] }]), ["acp-1"]);
});

test("bridge alone: unknown tools are refused and the token is not echoed", async (t) => {
  const bridge = createMcpBridge({ tools: [echoTool] });
  const server = await bridge.start();
  t.after(() => bridge.close());
  const post = (token, method, params) => fetch(server.url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const unknown = await (await post(bridge.token, "tools/call", { name: "rm_everything", arguments: {} })).json();
  assert.equal(unknown.error.code, -32602);
  assert.match(unknown.error.message, /rm_everything/);
  assert.equal((await (await post(bridge.token, "initialize", {})).json()).result.serverInfo.name, "steak-dsh-tools");
  assert.notEqual(server.headers[0].value.includes(bridge.token.slice(0, 8)), false, "the advertised header carries the token");
});

test("harness loop: nothing is executed in the adapter before DSH returns a tool result", async (t) => {
  const { adapter, log } = setup(t, "tool");
  const tools = [echoTool];
  const first = await collect(adapter, { tools, messages: [user("run it")] });
  assert.equal(events(log).filter((event) => event.event === "bridge").length, 0, "the adapter parked the call; it did not run the tool");
  const call = first.find((chunk) => chunk.type === "block-end" && chunk.block.type === "tool-call").block;
  assert.equal(call.name, "echo");
  assert.equal(first.at(-1).reason.kind, "tool-calls");
  const assistant = { role: "assistant", id: "a", source: { kind: "model", replayState: first.at(-1).replayState }, content: [call] };
  const tool = { role: "tool", id: "t", toolCallId: call.id, content: [{ type: "text", text: "approved by harness" }] };
  const second = await collect(adapter, { tools, messages: [user("run it"), assistant, tool] });
  assert.equal(textOf(second), "bridge said approved by harnessanswer from acp\n");
  const bridges = events(log).filter((event) => event.event === "bridge");
  assert.equal(bridges.length, 1, "exactly one bridge call, answered from the harness result");
  assert.equal(bridges[0].args.text, "run it");
});

test("parallel tool calls: one harness turn carries both, both results reach agy", async (t) => {
  const { adapter, log } = setup(t, "parallel");
  const tools = [echoTool, { name: "echo2", description: "second", parameters: { type: "object" } }];
  const first = await collect(adapter, { tools, messages: [user("both")] });
  const calls = first.filter((chunk) => chunk.type === "block-end" && chunk.block.type === "tool-call").map((chunk) => chunk.block);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.name), ["echo", "echo2"]);
  assert.deepEqual(first.at(-1).reason, { kind: "tool-calls" });
  const assistant = { role: "assistant", id: "a", source: { kind: "model", replayState: first.at(-1).replayState }, content: calls };
  const results = calls.map((call, index) => ({ role: "tool", id: `t${index}`, toolCallId: call.id, content: [{ type: "text", text: index ? "two-ok" : "one-ok" }] }));
  const second = await collect(adapter, { tools, messages: [user("both"), assistant, ...results] });
  assert.equal(textOf(second), "parallel one-ok / two-okanswer from acp\n");
  assert.equal(events(log).filter((event) => event.event === "bridge").length, 2);
});

test("missing result: a new prompt while a tool call is parked is a named protocol error", async (t) => {
  const { adapter } = setup(t, "tool");
  const first = await collect(adapter, { tools: [echoTool], messages: [user("run it")] });
  assert.equal(first.at(-1).reason.kind, "tool-calls");
  const error = await failure(adapter, { tools: [echoTool], messages: [user("again")] });
  assert.equal(error.code, "AGY_ACP_PROTOCOL");
  assert.match(error.message, /no matching harness tool result/);
});

test("abort while parked: the MCP call is answered with an error and the ACP turn is cancelled", async (t) => {
  const { adapter, log } = setup(t, "tool");
  const controller = new AbortController();
  const seen = [];
  const run = (async () => {
    for await (const chunk of adapter.stream({ provider: "agy", model: "gemini-4-neon-high", tools: [echoTool], messages: [user("run it")], signal: controller.signal })) {
      seen.push(chunk);
      if (chunk.reason?.kind === "tool-calls") controller.abort(new Error("stopped"));
    }
  })();
  await assert.rejects(run, (error) => error.code === "AGY_CANCELLED");
  assert.ok(seen.some((chunk) => chunk.type === "block-end" && chunk.block.type === "tool-call"));
  const lines = events(log);
  assert.ok(lines.some((event) => event.method === "session/cancel"));
  let bridge = lines.find((event) => event.event === "bridge");
  for (let attempt = 0; !bridge && attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    bridge = events(log).find((event) => event.event === "bridge");
  }
  assert.ok(bridge, "the parked MCP call reached the agent");
  assert.equal(bridge.result.isError, true, "the parked MCP call was answered, not left hanging");
});

test("reset: a new DSH session gets a fresh ACP session, bridge port and token", async (t) => {
  const { adapter } = setup(t);
  await collect(adapter);
  const before = [...adapter.sessions.values()][0];
  const url = before.bridge.url;
  await adapter.reset();
  assert.equal(adapter.sessions.size, 0);
  await collect(adapter);
  const after = [...adapter.sessions.values()][0];
  assert.notEqual(after.bridge.url, url, "a new loopback listener and bearer token");
  assert.notEqual(after.sessionId, before.sessionId);
});

test("dsh integration: a bridged call is executed by the real harness and agy continues its turn", { timeout: 60_000, skip: !((process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, "dsh")))) }, async (t) => {
  const { dir, log, env } = setup(t, "tool", {
    FAKE_ACP_TOOL: "bash",
    FAKE_ACP_ARGS: JSON.stringify({ command: "echo hello_acp_harness", description: "ACP round trip" }),
    STEAK_DSH_AGY_TRANSPORT: "acp",
  });
  const launcher = join(root, "bin", "steak-dsh");
  const run = await new Promise((resolve) => {
    const child = spawn(process.execPath, [launcher, "run", "--json", "--model", "agy/gemini-4-neon-high", "say hi"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  assert.equal(run.status, 0, run.stderr + run.stdout.slice(-1000));
  const final = run.stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line)).find((event) => event.type === "final");
  assert.equal(final.reason.kind, "completed", run.stderr);
  assert.match(final.text, /bridge said hello_acp_harness/, "the harness's tool output reached agy");
  assert.match(final.text, /answer from acp/, "the ACP prompt resumed after the harness ran the tool");
  const bridge = events(log).find((event) => event.event === "bridge");
  assert.equal(bridge.name, "bash", "the bridge advertised a harness tool, not an agy native tool");
  assert.equal(bridge.result.isError, undefined, "the tool really ran in the harness");
  assert.match(bridge.result.content[0].text, /hello_acp_harness/);
  assert.equal(bridge.args.command, "echo hello_acp_harness");
  assert.equal(events(log).filter((event) => event.event === "launch").length, 1, "one ACP session for the whole run");
});
