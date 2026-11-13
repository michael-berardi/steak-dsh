// Pure parts of the Claude Code route: message translation, stream translation, usage, caching limits, wait bounds.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadHarness } from "../claude-code/harness.js";
import { capCacheBreakpoints, MAX_CACHE_BREAKPOINTS } from "../claude-code/cache-control.js";
import { claudeToolName, harnessToolName, TOOL_PREFIX } from "../claude-code/tool-names.js";
import { normalizeRow, rowsFromDiscovery, resolvedModel } from "../claude-code/models.js";
import { EventTranslator, mapStopReason, mapUsage, normalizeErrorMessage } from "../claude-code/stream.js";
import { normalizeInputSchema, prepareFrames, prepareTools, systemPromptText } from "../claude-code/transcript.js";
import { transportTimeout, waitForOperation, ClaudeWaitLimitError } from "../claude-code/wait.js";
import { envFlagEnabled } from "../claude-code/env.js";

const folder = join(import.meta.dirname, "..", "claude-code");
const text = (t) => ({ type: "text", text: t });
const msg = (role, content, extra = {}) => ({ role, id: role, content, source: { kind: role === "assistant" ? "model" : role }, ...extra });

test("the module folder imports only Node built-ins or its own files, and names no model", () => {
  for (const file of readdirSync(folder).filter((f) => /\.m?js$/.test(f))) {
    const source = readFileSync(join(folder, file), "utf8");
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
      assert.match(match[1], /^(node:|\.\.?\/)/, `${file} imports ${match[1]}`);
    }
    assert.doesNotMatch(source, /\b(opus|sonnet|haiku|fable|qwen|gpt-|deepseek-v|openrouter|openai)\b/i, `${file} names a model or another provider`);
  }
});

test("the module folder carries the upstream licence notice", () => {
  const licence = readFileSync(join(folder, "LICENSE"), "utf8");
  assert.match(licence, /MIT License/);
  assert.match(licence, /Copyright \(c\) 2026 Armin Ronacher/);
});

test("the loader reaches the installed harness package, and falls back to the local contract", async () => {
  const dshBin = "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js";
  const found = await loadHarness({ entry: dshBin });
  if (found.source === "harness") {
    assert.equal(typeof found.LlmAdapter, "function");
    assert.equal(typeof found.LlmError, "function");
    const error = new found.LlmError("x", "CODE");
    assert.equal(error.code, "CODE");
  } else {
    assert.ok(!(await import("node:fs")).existsSync(dshBin), "the harness is installed here, so the loader must find it");
  }
  const local = await loadHarness({ entry: "/definitely/not/here" });
  assert.equal(local.source, "fallback");
  const adapter = new (class extends local.LlmAdapter { async *stream() {} })();
  assert.deepEqual(adapter.providerInfo("p"), { id: "p", name: "p" });
  assert.deepEqual(await adapter.listModels("p"), []);
  assert.deepEqual((await adapter.prepareCall("p", "m")).model, { provider: "p", id: "m", name: "m" });
});

test("frames: history frames never query, tool results merge into one user frame, the last frame answers", () => {
  const frames = prepareFrames([
    msg("system", [text("sys")]),
    msg("user", [text("a")]),
    msg("assistant", [text("b"), { type: "tool-call", id: "c1", name: "t", arguments: '{"k":1}' }, { type: "tool-call", id: "c2", name: "t", arguments: "{}" }]),
    msg("tool", [text("r1")], { toolCallId: "c1", isError: false }),
    msg("tool", [text("r2")], { toolCallId: "c2", isError: true }),
  ]);
  assert.deepEqual(frames.map((f) => f.type), ["user", "assistant", "user"]);
  assert.equal(frames[0].shouldQuery, false);
  assert.equal(frames[1].shouldQuery, undefined);
  assert.equal(frames[2].shouldQuery, undefined);
  assert.deepEqual(frames[1].message.content[1], { type: "tool_use", id: "c1", name: `${TOOL_PREFIX}t`, input: { k: 1 } });
  assert.deepEqual(frames[2].message.content.map((b) => [b.tool_use_id, b.is_error]), [["c1", false], ["c2", true]]);
});

test("frames: history must end with something to answer", () => {
  assert.throws(() => prepareFrames([msg("user", [text("a")]), msg("assistant", [text("b")])]), /must end in a non-empty user or tool-result/);
});

test("frames: images are named, not sent, because the route takes text only", () => {
  const frames = prepareFrames([msg("user", [text("see"), { type: "image", attachment: { name: "p.png" } }])]);
  assert.match(frames[0].message.content[1].text, /image: p\.png omitted/);
});

test("system prompt: the one-shot option comes first, then the leading system message", () => {
  assert.equal(systemPromptText({ system: "one", messages: [msg("system", [text("two")])] }), "one\n\ntwo");
  assert.equal(systemPromptText({ messages: [msg("user", [text("x")])] }), "");
});

test("tool names: short names pass through, long or odd names get a stable alias that maps back", () => {
  assert.equal(claudeToolName("bash"), "bash");
  const long = "mcp__server__" + "x".repeat(60);
  const alias = claudeToolName(long);
  assert.ok(alias.length <= 50);
  assert.equal(claudeToolName(long), alias);
  const prepared = prepareTools([{ name: long, description: "d", parameters: {} }, { name: "né", description: "d", parameters: {} }]);
  assert.equal(harnessToolName(`${TOOL_PREFIX}${alias}`, prepared.names), long);
  assert.equal(harnessToolName(alias, prepared.names), long, "the bare alias is accepted too");
  assert.throws(() => harnessToolName(`${TOOL_PREFIX}unknown`, prepared.names), /unavailable tool unknown/);
  assert.throws(() => harnessToolName("other", prepared.names), /unexpected tool other/);
  assert.throws(() => prepareTools([{ name: "a", description: "", parameters: {} }, { name: "a", description: "", parameters: {} }]), /unique/);
});

test("tool schemas: nullable types and composition keywords are simplified for the CLI", () => {
  const out = normalizeInputSchema({ type: "object", properties: { a: { type: ["string", "null"] }, b: { anyOf: [{ type: "number" }, { type: "null" }] } }, oneOf: [{}] });
  assert.equal(out.properties.a.type, "string");
  assert.equal(out.properties.b.type, "number");
  assert.equal(out.oneOf, undefined);
  assert.deepEqual(normalizeInputSchema({}), { type: "object", properties: {} });
});

test("usage is reported in the harness's disjoint form", () => {
  assert.deepEqual(mapUsage({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40, output_tokens_details: { thinking_tokens: 5 } }), {
    inputTokens: 10, outputTokens: 20, totalTokens: 370, cacheReadTokens: 300, cacheWriteTokens: 40, reasoningTokens: 5,
  });
  assert.deepEqual(mapUsage({ input_tokens: 1, output_tokens: 2 }), { inputTokens: 1, outputTokens: 2, totalTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test("stop reasons map to finish kinds; refusals and unknown reasons are errors", () => {
  assert.deepEqual(mapStopReason("end_turn"), { kind: "stop" });
  assert.deepEqual(mapStopReason("tool_use"), { kind: "tool-calls" });
  assert.deepEqual(mapStopReason("max_tokens"), { kind: "max-tokens" });
  assert.match(mapStopReason("refusal").error, /refused/);
  assert.match(mapStopReason("weird").error, /Unhandled Claude Code stop reason: weird/);
});

test("stream events become blocks in order, with tool arguments as the raw JSON string", () => {
  const names = new Map([["echo", "echo"]]);
  const t = new EventTranslator(names);
  const chunks = [
    ...t.event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
    ...t.event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } }),
    ...t.event({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }),
    ...t.event({ type: "content_block_stop", index: 0 }),
    ...t.event({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "c1", name: `${TOOL_PREFIX}echo`, input: {} } }),
    ...t.event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"a"' } }),
    ...t.event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ":1}" } }),
    ...t.event({ type: "content_block_stop", index: 1 }),
  ];
  assert.deepEqual(chunks.map((c) => c.type), ["block-start", "reasoning-delta", "block-end", "block-start", "tool-call-delta", "tool-call-delta", "tool-call-delta", "block-end"]);
  assert.deepEqual(chunks.at(-1).block, { type: "tool-call", id: "c1", name: "echo", arguments: '{"a":1}' });
  const message = { stop_reason: "tool_use", content: [{ type: "thinking", thinking: "hm", signature: "sig" }, { type: "tool_use", id: "c1", name: `${TOOL_PREFIX}echo`, input: { a: 1 } }] };
  const done = t.finish(message, { input_tokens: 1, output_tokens: 1 });
  assert.deepEqual(done.map((c) => c.type), ["usage", "finish"]);
  assert.equal(done[1].replayState.response.message.content[0].signature, "sig");
});

test("a final message that differs from what streamed is an error, not silently trusted", () => {
  const t = new EventTranslator(new Map());
  t.event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  t.event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "one" } });
  t.event({ type: "content_block_stop", index: 0 });
  assert.throws(() => t.finish({ stop_reason: "end_turn", content: [{ type: "text", text: "two" }] }, { input_tokens: 1, output_tokens: 1 }), /differs from its incremental stream/);
});

test("usage-credit rejections and context overflow get their own codes", () => {
  assert.equal(normalizeErrorMessage(new Error("Third-party apps now draw from your extra usage")).code, "CLAUDE_CODE_BILLING");
  assert.equal(normalizeErrorMessage(new Error("prompt is too long: 300000 tokens")).code, "CONTEXT_WINDOW_EXCEEDED");
  assert.equal(normalizeErrorMessage(new Error("plain")).message, "plain");
});

test("catalog rows: context, efforts and repeats come from the row", () => {
  const rows = rowsFromDiscovery([
    { value: "a", displayName: "A", description: "with 1M context", supportedEffortLevels: ["low", "max"] },
    { value: "a", displayName: "dup", description: "" },
    { value: "b[1m]", displayName: "B", description: "" },
    { value: "c", displayName: "C", description: "", contextWindow: 123456, maxTokens: 999 },
    { displayName: "no id", description: "" },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["a", "b[1m]", "c"]);
  assert.equal(rows[0].contextWindow, 1_000_000);
  assert.equal(rows[1].contextWindow, 1_000_000);
  assert.equal(rows[2].contextWindow, 123456);
  assert.deepEqual(resolvedModel("p", rows[0]).reasoning.efforts.map((e) => e.id), ["low", "max"]);
  assert.equal(normalizeRow({ value: "z", displayName: "Z", description: "" }).contextWindow, 200_000);
});

test("cache markers are capped at the API limit, oldest message marker first", () => {
  const mark = () => ({ cache_control: { type: "ephemeral" } });
  const payload = {
    tools: [{ name: "t", ...mark() }],
    system: [{ type: "text", text: "s", ...mark() }],
    messages: [
      { role: "user", content: [{ type: "text", text: "1", ...mark() }] },
      { role: "user", content: [{ type: "text", text: "2", ...mark() }] },
      { role: "user", content: [{ type: "text", text: "3", ...mark() }] },
    ],
  };
  const result = capCacheBreakpoints(payload);
  assert.equal(MAX_CACHE_BREAKPOINTS, 4);
  assert.deepEqual(result, { remaining: 4, dropped: 1 });
  assert.equal(payload.messages[0].content[0].cache_control, undefined, "the oldest message marker went");
  assert.ok(payload.tools[0].cache_control && payload.system[0].cache_control && payload.messages[2].content[0].cache_control);
});

test("waits: a deadline must be finite, every wait settles, abort wins", async () => {
  assert.equal(transportTimeout(undefined), 180_000);
  for (const bad of [0, -1, Infinity, NaN, 2 ** 31]) assert.throws(() => transportTimeout(bad), /positive finite/);
  let stopped = 0;
  await assert.rejects(waitForOperation(new Promise(() => {}), 40, "thing", undefined, () => { stopped += 1; }), (e) => e instanceof ClaudeWaitLimitError && e.code === "CLAUDE_CODE_WAIT_LIMIT" && /thing exceeded its wait limit/.test(e.message));
  assert.equal(stopped, 1);
  const controller = new AbortController();
  const waiting = waitForOperation(new Promise(() => {}), 10_000, "thing", controller.signal);
  controller.abort(new Error("cancelled"));
  await assert.rejects(waiting, /cancelled/);
  assert.equal(await waitForOperation(Promise.resolve(7), 1000, "x"), 7);
});

test("environment flags: only explicit off values are off", () => {
  for (const off of [undefined, "", "0", "false", "No", " OFF "]) assert.equal(envFlagEnabled(off), false, String(off));
  for (const on of ["1", "true", "yes", "on"]) assert.equal(envFlagEnabled(on), true, on);
});

test("launcher: claude-code needs no endpoint or key, refuses an endpoint, and is left out by --stock", async () => {
  const { parseOptions } = await import("../lib/args.js");
  const { options } = parseOptions(["--model", "claude-code/some-row[1m]", "--effort", "high", "task"]);
  assert.equal(options.provider, "claude-code");
  assert.equal(options.model, "some-row[1m]");
  assert.equal(options.baseUrl, undefined);
  assert.equal(options.keyEnv, undefined);
  assert.throws(() => parseOptions(["--stock", "--model", "claude-code/x", "task"]), /part of the bundle that --stock leaves out/);
  assert.throws(() => parseOptions(["--model", "claude-code/x", "--base-url", "https://e.test", "--api", "openai-completions", "--key-env", "K", "task"]), /cannot name the claude-code route/);
  assert.throws(() => parseOptions(["--stock", "--verify", "true", "task"]), /cannot be combined with --stock/);
  assert.throws(() => parseOptions(["--stock", "--long", "task"]), /cannot be combined with --stock/);
});

// With either switch set, the CLI answers the model-list request from a short built-in list, so newer models the
// login can use were not offered. Discovery runs without the two switches; every request keeps them.
test("model discovery lets the CLI fetch its live catalog; requests stay quiet", async () => {
  const { discoveryEnvironment, processEnvironment } = await import("../claude-code/claude-cli.js");
  const inherited = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1" };
  const discovery = discoveryEnvironment(inherited);
  assert.equal(discovery.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
  assert.equal(discovery.DISABLE_TELEMETRY, undefined);
  assert.equal(discovery.CLAUDE_CODE_MAX_RETRIES, "0");
  assert.equal(discovery.ENABLE_TOOL_SEARCH, "false");
  const request = processEnvironment({}, {});
  assert.equal(request.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(request.DISABLE_TELEMETRY, "1");
  assert.throws(() => discoveryEnvironment({ ANTHROPIC_API_KEY: "x" }), /refuses conflicting auth/);
});
