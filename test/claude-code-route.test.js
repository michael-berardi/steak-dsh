// The Claude Code model route, against a fake `claude` executable (test/fixtures/fake-claude.mjs).
import test, { before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FAKE, alive, childPids, closeClaudeProcesses, collect, failure, liveClaudeWorkerCount, makeAdapter, readLog,
  request, resetClaudeStatusCache, scratchDir, sseText, startUpstream, user, waitFor, warmFake,
} from "./cc-helpers.js";

const dirs = [];
const dir = () => { const d = scratchDir(); dirs.push(d); return d; };
const echoTool = { name: "echo", description: "echo back", parameters: { type: "object", properties: { text: { type: "string" } } } };

before(() => warmFake());
afterEach(async () => {
  resetClaudeStatusCache();
  await closeClaudeProcesses();
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

// ---------------------------------------------------------------- G1: route and discovery

test("G1: models are discovered from the CLI, not listed in the module", async () => {
  const { adapter } = makeAdapter(dir());
  const models = await adapter.listModels("claude-code");
  assert.deepEqual(models.map((m) => m.id), ["default", "small"]);
  assert.equal(models[0].provider, "claude-code");
  assert.deepEqual(models[0].inputModalities, ["text"]);
  const custom = makeAdapter(dir(), { FAKE_CLAUDE_CATALOG: JSON.stringify([{ value: "row-a", displayName: "A", description: "x" }]) });
  assert.deepEqual((await custom.adapter.listModels("claude-code")).map((m) => m.id), ["row-a"]);
});

test("G1: exact-route metadata carries context size and effort levels from the CLI row", async () => {
  const { adapter } = makeAdapter(dir());
  const info = await adapter.resolveModel("claude-code", "default");
  assert.equal(info.context.contextWindow, 1_000_000);
  assert.deepEqual(info.reasoning.efforts.map((e) => e.id), ["low", "high"]);
  const plain = await adapter.resolveModel("claude-code", "small");
  assert.equal(plain.context.contextWindow, 200_000);
  assert.equal(plain.reasoning, undefined);
  const unknown = await adapter.resolveModel("claude-code", "not-listed");
  assert.equal(unknown.id, "not-listed");
});

test("G1: a missing CLI offers no models and a request fails with one named, actionable error", async () => {
  const d = dir();
  const { adapter } = makeAdapter(d, { STEAK_DSH_CLAUDE_CODE_COMMAND: join(d, "no-such-claude") });
  assert.deepEqual(await adapter.listModels("claude-code"), []);
  const error = await failure(adapter, request([user("hi")]));
  assert.equal(error.code, "CLAUDE_CODE_NOT_READY");
  assert.match(error.message, /not installed/);
  assert.match(error.message, /STEAK_DSH_CLAUDE_CODE_COMMAND/);
});

test("G1: a logged-out CLI offers no models and a request fails with the login instruction", async () => {
  const { adapter, log } = makeAdapter(dir(), { FAKE_CLAUDE_MODE: "logged-out" });
  assert.deepEqual(await adapter.listModels("claude-code"), []);
  const error = await failure(adapter, request([user("hi")]));
  assert.equal(error.code, "CLAUDE_CODE_NOT_READY");
  assert.match(error.message, /claude auth login/);
  assert.equal(readLog(log).filter((e) => e.event === "launch").length, 0, "no model process starts when logged out");
});

test("G1: the plugin registers exactly one route named claude-code and touches nothing else", async () => {
  const { apply, name, inject } = await import("../claude-code/plugin.js");
  assert.equal(name, "steak-claude-code");
  assert.deepEqual(inject, ["llm"]);
  const registered = [];
  let disposed = 0;
  const effects = [];
  const ctx = {
    effect: (fn) => { effects.push(fn()); },
    llm: { registerAdapter: (providers, adapter) => { registered.push({ providers, adapter }); return () => { disposed += 1; }; } },
  };
  const started = childPids();
  apply(ctx, {});
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0].providers, ["claude-code"]);
  assert.deepEqual(childPids(), started, "registering the route starts no process");
  assert.equal(registered[0].adapter.providerInfo("claude-code").id, "claude-code");
  for (const dispose of effects) dispose();
  assert.equal(disposed, 1, "disposing the effect releases the route");
});

// ---------------------------------------------------------------- G2: billing safety

test("G2: inherited key, proxy and cloud-provider overrides are refused before any process starts", async () => {
  const overrides = [
    { ANTHROPIC_API_KEY: "sk-ant-test-not-a-real-key" },
    { ANTHROPIC_AUTH_TOKEN: "token-not-real" },
    { ANTHROPIC_BASE_URL: "https://proxy.example.test" },
    { ANTHROPIC_FOUNDRY_API_KEY: "foundry-not-real" },
    { CLAUDE_CODE_USE_BEDROCK: "1" },
    { CLAUDE_CODE_USE_VERTEX: "true" },
    { CLAUDE_CODE_USE_FOUNDRY: "yes" },
  ];
  for (const override of overrides) {
    const { adapter, log } = makeAdapter(dir(), override);
    const error = await failure(adapter, request([user("hi")]));
    const [key, value] = Object.entries(override)[0];
    assert.equal(error.code, "CLAUDE_CODE_CONFLICTING_ENV", key);
    assert.match(error.message, new RegExp(key));
    assert.ok(!error.message.includes(value) || value.length < 4, `${key}: the value is never echoed`);
    assert.equal(readLog(log).filter((e) => e.event === "launch").length, 0, `${key}: nothing launched`);
  }
});

test("G2: an explicit off value of a cloud flag is not a conflict", async () => {
  const { adapter } = makeAdapter(dir(), { CLAUDE_CODE_USE_BEDROCK: "0" });
  const chunks = await collect(adapter, request([user("hi")]));
  assert.equal(chunks.at(-1).type, "finish");
});

test("G2: the child sees no key or endpoint override except the loopback relay, and the module never reads credentials", async () => {
  const { adapter, log } = makeAdapter(dir());
  await collect(adapter, request([user("hi")]));
  const launch = readLog(log).find((e) => e.event === "launch" && !e.discovery);
  assert.equal(launch.apiKeySet, false);
  assert.equal(launch.baseUrlSet, true, "only the relay's own loopback URL");
  const { readFileSync, readdirSync } = await import("node:fs");
  const folder = join(import.meta.dirname, "..", "claude-code");
  for (const file of readdirSync(folder).filter((f) => /\.m?js$/.test(f))) {
    const source = readFileSync(join(folder, file), "utf8");
    assert.doesNotMatch(source, /\.credentials|credentials\.json|keychain|security find-generic|\.claude\.json|oauth/i, `${file} touches credential storage`);
  }
});

test("G2: a turn the CLI reports as charged to usage credits fails with a non-retryable billing error", async () => {
  const upstream = await startUpstream((_req, res) => sseText(res, "paid"));
  try {
    const { adapter } = makeAdapter(dir(), { FAKE_CLAUDE_MODE: "http,billing" }, { upstreamUrl: upstream.url });
    const error = await failure(adapter, request([user("hi")]));
    assert.equal(error.code, "CLAUDE_CODE_BILLING");
    assert.match(error.message, /Claude Code billing/);
    assert.match(error.message, /STEAK_DSH_CLAUDE_CODE_ALLOW_USAGE_CREDITS/);
    assert.ok(!["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"].includes(error.code), "outside the default retryable codes");
  } finally { await upstream.close(); }
});

test("G2: the documented opt-in lets a usage-credit turn through", async () => {
  const upstream = await startUpstream((_req, res) => sseText(res, "paid"));
  try {
    const { adapter } = makeAdapter(dir(), { FAKE_CLAUDE_MODE: "http,billing", STEAK_DSH_CLAUDE_CODE_ALLOW_USAGE_CREDITS: "1" }, { upstreamUrl: upstream.url });
    const chunks = await collect(adapter, request([user("hi")]));
    assert.equal(chunks.at(-1).type, "finish");
  } finally { await upstream.close(); }
});

test("G2: an upstream usage-credit rejection is rewritten into the same billing error", async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Third-party apps now draw from your extra usage" } }));
  });
  try {
    const { adapter } = makeAdapter(dir(), { FAKE_CLAUDE_MODE: "http" }, { upstreamUrl: upstream.url });
    const error = await failure(adapter, request([user("hi")]));
    assert.equal(error.code, "CLAUDE_CODE_BILLING");
  } finally { await upstream.close(); }
});

// ---------------------------------------------------------------- G3: the harness owns the tools

test("G3: the CLI is launched with no tools of its own, one turn, and only the inert inventory", async () => {
  const { adapter, log } = makeAdapter(dir());
  await collect(adapter, request([user("hi")], { tools: [echoTool] }));
  const launch = readLog(log).find((e) => e.event === "launch" && !e.discovery);
  assert.equal(launch.tools, "");
  assert.equal(launch.maxTurns, "1");
  assert.deepEqual(launch.mcpCommands, [{ name: "dsh", script: "inert-mcp.mjs" }]);
});

test("G3: the inert inventory lists the tools and refuses to run any", async () => {
  const { spawn } = await import("node:child_process");
  const { writeFileSync: write } = await import("node:fs");
  const d = dir();
  const manifest = join(d, "tools.json");
  write(manifest, JSON.stringify([{ name: "echo", description: "e", inputSchema: { type: "object", properties: {} } }]));
  const child = spawn(process.execPath, [join(import.meta.dirname, "..", "claude-code", "inert-mcp.mjs"), manifest], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => lines.push(...c.split("\n").filter(Boolean)));
  for (const [id, method] of [[1, "initialize"], [2, "tools/list"], [3, "tools/call"]]) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }) + "\n");
  await waitFor(() => lines.length >= 3);
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
  const [init, list, call] = lines.map((l) => JSON.parse(l));
  assert.equal(init.result.serverInfo.name, "dsh-inert-tool-inventory");
  assert.deepEqual(list.result.tools.map((t) => t.name), ["echo"]);
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /only the harness executes tools/);
});

test("G3: exactly one upstream request per turn; a second native attempt is refused by the relay", async () => {
  const upstream = await startUpstream((_req, res) => sseText(res, "from upstream"));
  try {
    const { adapter, log } = makeAdapter(dir(), { FAKE_CLAUDE_MODE: "double" }, { upstreamUrl: upstream.url });
    const chunks = await collect(adapter, request([user("hi")]));
    assert.equal(upstream.requests.length, 1, "one request reached the vendor API");
    const posts = readLog(log).filter((e) => e.event === "post");
    assert.deepEqual(posts.map((p) => p.status), [200, 400]);
    assert.equal(posts[1].denied, true);
    const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
    assert.equal(text, "from upstream");
    assert.deepEqual(chunks.find((c) => c.type === "usage").usage, {
      inputTokens: 9, outputTokens: 4, totalTokens: 13, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
  } finally { await upstream.close(); }
});

test("G3: tool calls come back as harness tool calls and results round-trip with signed thinking kept", async () => {
  const d = dir();
  const { adapter, log } = makeAdapter(d, { FAKE_CLAUDE_MODE: "thinking,tool", FAKE_CLAUDE_TOOL: "echo", FAKE_CLAUDE_TOOL_INPUT: JSON.stringify({ text: "x" }) });
  const first = await collect(adapter, request([user("use the tool")], { tools: [echoTool] }));
  const call = first.find((c) => c.type === "block-end" && c.block.type === "tool-call").block;
  assert.deepEqual({ name: call.name, arguments: JSON.parse(call.arguments) }, { name: "echo", arguments: { text: "x" } });
  const finish = first.at(-1);
  assert.deepEqual(finish.reason, { kind: "tool-calls" });
  assert.ok(first.some((c) => c.type === "block-end" && c.block.type === "reasoning"), "thinking is reported");
  assert.deepEqual(first.find((c) => c.type === "usage").usage, {
    inputTokens: 11, outputTokens: 7, totalTokens: 26, cacheReadTokens: 5, cacheWriteTokens: 3, reasoningTokens: 2,
  });

  // The next turn: the harness replays the assistant message (with its replay state) and the tool result.
  const assistant = {
    role: "assistant", id: "a1",
    source: { kind: "model", provider: "claude-code", model: "default", replayState: finish.replayState },
    content: first.filter((c) => c.type === "block-end").map((c) => c.block),
  };
  const tool = { role: "tool", id: "t1", source: { kind: "tool", callId: call.id }, toolCallId: call.id, isError: false, content: [{ type: "text", text: "x" }] };
  const second = await collect(adapter, request([user("use the tool"), assistant, tool], { tools: [echoTool] }));
  assert.equal(second.at(-1).type, "finish");
  const queries = readLog(log).filter((e) => e.event === "query");
  const frames = queries.at(-1).frames;
  assert.deepEqual(frames.map((f) => f.type), ["user", "assistant", "user"]);
  assert.deepEqual(frames[1].blocks, ["thinking", "text", "tool_use"]);
  assert.equal(frames[1].signature, "sig-1", "the signed thinking block is replayed untouched");
  assert.deepEqual(frames[2].blocks, ["tool_result"]);
  assert.equal(frames[0].shouldQuery, false);
});

test("G3: a message without replay state replays as text and tool calls only", async () => {
  const { adapter, log } = makeAdapter(dir(), { FAKE_CLAUDE_MODE: "text" });
  const assistant = { role: "assistant", id: "a1", source: { kind: "model", provider: "other", model: "m" }, content: [{ type: "reasoning", text: "unsigned" }, { type: "text", text: "earlier" }, { type: "tool-call", id: "c1", name: "echo", arguments: "{}" }] };
  const tool = { role: "tool", id: "t1", source: { kind: "tool", callId: "c1" }, toolCallId: "c1", content: [{ type: "text", text: "r" }] };
  await collect(adapter, request([user("q"), assistant, tool], { tools: [echoTool] }));
  const frames = readLog(log).filter((e) => e.event === "query").at(-1).frames;
  assert.deepEqual(frames[1].blocks, ["text", "tool_use"]);
});

test("G3: a tool the harness did not offer is refused", async () => {
  const { adapter } = makeAdapter(dir(), { FAKE_CLAUDE_MODE: "tool", FAKE_CLAUDE_TOOL: "rm_everything" });
  const error = await failure(adapter, request([user("hi")], { tools: [echoTool] }));
  assert.equal(error.code, "CLAUDE_CODE_UNKNOWN_TOOL");
});

test("G3: reasoning effort selects thinking, none disables it", async () => {
  const { buildExtraBody } = await import("../claude-code/transcript.js");
  assert.deepEqual(buildExtraBody([], { reasoningEffort: "high" }), { tools: [], thinking: { type: "adaptive" }, output_config: { effort: "high" } });
  assert.deepEqual(buildExtraBody([], { reasoningEffort: "high", adaptive: false }), { tools: [], output_config: { effort: "high" } });
  assert.deepEqual(buildExtraBody([], { maxTokens: 99 }), { tools: [], max_tokens: 99, thinking: { type: "disabled" }, context_management: { edits: [] } });
});

// ---------------------------------------------------------------- G4: cancellation, deadlines, orphans

test("G4: an aborted request stops the whole process tree, including a grandchild", async () => {
  const d = dir();
  const { adapter, log } = makeAdapter(d, { FAKE_CLAUDE_MODE: "hang" });
  const before = childPids();
  const controller = new AbortController();
  const pending = failure(adapter, request([user("hi")], { signal: controller.signal }));
  const grandchild = await waitFor(() => readLog(log).find((e) => e.event === "grandchild"));
  assert.ok(grandchild, "the fake reached its query and started a grandchild");
  const leader = grandchild.pid;
  assert.ok(alive(leader) && alive(grandchild.child));
  controller.abort(new Error("stop now"));
  const error = await pending;
  assert.match(error.message, /stop now/);
  assert.equal(await waitFor(() => !alive(leader) && !alive(grandchild.child)), true, "leader and grandchild are gone");
  assert.equal(await waitFor(() => liveClaudeWorkerCount() === 0), true);
  assert.deepEqual(childPids().filter((p) => !before.includes(p)), [], "no child of this process remains");
});

test("G4: every wait has a bound and a named error, and nothing is left running", async () => {
  const d = dir();
  const { adapter, log } = makeAdapter(d, { FAKE_CLAUDE_MODE: "hang" }, { timeoutMs: 700 });
  const started = Date.now();
  const error = await failure(adapter, request([user("hi")]));
  assert.equal(error.code, "CLAUDE_CODE_WAIT_LIMIT");
  assert.match(error.message, /wait limit|idle limit/);
  assert.ok(Date.now() - started < 8000, "bounded");
  const grandchild = readLog(log).find((e) => e.event === "grandchild");
  assert.equal(await waitFor(() => !alive(grandchild.pid) && !alive(grandchild.child)), true);
  assert.equal(liveClaudeWorkerCount(), 0);
});

test("G4: a CLI that dies mid-request fails with its exit code and leaves nothing behind", async () => {
  const before = childPids();
  const { adapter } = makeAdapter(dir(), { FAKE_CLAUDE_MODE: "crash" });
  const error = await failure(adapter, request([user("hi")]));
  assert.match(error.message, /exit 3/);
  assert.match(error.message, /fake crash/);
  assert.equal(await waitFor(() => liveClaudeWorkerCount() === 0), true);
  assert.deepEqual(childPids().filter((p) => !before.includes(p)), []);
});

test("G4: a finished one-shot request leaves no process; a session keeps one warm worker that closes on request", async () => {
  const before = childPids();
  const { adapter, log } = makeAdapter(dir());
  await collect(adapter, request([user("one")]));
  assert.equal(liveClaudeWorkerCount(), 0, "no session id: nothing kept warm");
  assert.deepEqual(childPids().filter((p) => !before.includes(p)), []);

  const first = await collect(adapter, request([user("two")], { sessionId: "s-1" }));
  assert.equal(liveClaudeWorkerCount(), 1, "a session id keeps one warm worker");
  const pid = readLog(log).filter((e) => e.event === "launch" && !e.discovery).at(-1).pid;
  assert.ok(alive(pid));
  // A linear continuation reuses the worker: no second launch.
  const assistant = { role: "assistant", id: "a1", source: { kind: "model", provider: "claude-code", model: "default", replayState: first.at(-1).replayState }, content: first.filter((c) => c.type === "block-end").map((c) => c.block) };
  const launchesBefore = readLog(log).filter((e) => e.event === "launch" && !e.discovery).length;
  await collect(adapter, request([user("two"), assistant, user("three")], { sessionId: "s-1" }));
  assert.equal(readLog(log).filter((e) => e.event === "launch" && !e.discovery).length, launchesBefore, "warm worker reused");
  await adapter.close("s-1");
  assert.equal(await waitFor(() => !alive(pid)), true);
  assert.equal(liveClaudeWorkerCount(), 0);
});

test("G4: a host that exits without closing the route leaves no Claude process behind", async () => {
  const d = dir();
  const { spawn } = await import("node:child_process");
  const script = join(d, "exit-without-close.mjs");
  writeFileSync(script, `
import { join } from "node:path";
const root = ${JSON.stringify(join(import.meta.dirname, ".."))};
const { createClaudeCodeAdapter } = await import(join(root, "claude-code", "adapter.js"));
const { loadHarness } = await import(join(root, "claude-code", "harness.js"));
const adapter = createClaudeCodeAdapter(await loadHarness({ entry: "/nonexistent" }), { env: () => process.env });
const messages = [{ role: "system", content: [{ type: "text", text: "s" }] }, { role: "user", content: [{ type: "text", text: "hi" }] }];
for await (const chunk of adapter.stream({ provider: "claude-code", model: "default", messages, tools: [], sessionId: "keep" })) void chunk;
process.exit(0);
`);
  const log = join(d, "fake.log");
  const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH, HOME: process.env.HOME, STEAK_DSH_CLAUDE_CODE_COMMAND: FAKE, FAKE_CLAUDE_LOG: log }, stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  const launch = readLog(log).find((e) => e.event === "launch" && !e.discovery);
  assert.ok(launch, "the worker was started");
  assert.equal(await waitFor(() => !alive(launch.pid)), true, "the warm worker died with its host");
});
