#!/usr/bin/env node
// A stand-in for the Claude Code CLI, enough of its stream-json protocol to drive the route in tests.
// Behaviour comes from FAKE_CLAUDE_* variables; every launch and key step is appended to FAKE_CLAUDE_LOG.
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import http from "node:http";

const args = process.argv.slice(2);
const env = process.env;
const modes = new Set((env.FAKE_CLAUDE_MODE ?? "text").split(",").filter(Boolean));
const record = (entry) => { if (env.FAKE_CLAUDE_LOG) appendFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, ...entry }) + "\n"); };
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");

if (args[0] === "auth" && args[1] === "status") {
  record({ event: "auth-status" });
  if (modes.has("logged-out")) emit({ loggedIn: false });
  else emit({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" });
  process.exit(0);
}

const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const discovery = flag("--system-prompt-file") === undefined;
record({
  event: "launch", discovery, model: flag("--model"), ppid: process.ppid,
  baseUrlSet: Boolean(env.ANTHROPIC_BASE_URL), apiKeySet: Boolean(env.ANTHROPIC_API_KEY),
  extraBody: (() => { try { return JSON.parse(JSON.stringify(env.CLAUDE_CODE_EXTRA_BODY ? "set" : "unset")); } catch { return undefined; } })(),
  maxTurns: flag("--max-turns"), tools: flag("--tools"),
});

const CATALOG = JSON.parse(env.FAKE_CLAUDE_CATALOG ?? "null") ?? [
  { value: "default", displayName: "Default", description: "Default row with 1M context", supportsEffort: true, supportedEffortLevels: ["low", "high"], supportsAdaptiveThinking: true },
  { value: "small", displayName: "Small", description: "Fast row" },
];

const sseEvent = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

function nativeMessage() {
  const content = [];
  if (modes.has("thinking")) content.push({ type: "thinking", thinking: "pondering", signature: "sig-1" });
  content.push({ type: "text", text: env.FAKE_CLAUDE_TEXT ?? "fake reply" });
  if (modes.has("tool")) content.push({ type: "tool_use", id: "toolu_1", name: `mcp__dsh__${env.FAKE_CLAUDE_TOOL ?? "echo"}`, input: JSON.parse(env.FAKE_CLAUDE_TOOL_INPUT ?? "{}") });
  return {
    id: "msg_fake", role: "assistant", content,
    stop_reason: modes.has("tool") ? "tool_use" : "end_turn",
    usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 3, ...(modes.has("thinking") ? { output_tokens_details: { thinking_tokens: 2 } } : {}) },
  };
}

function directStream(message) {
  emit({ type: "stream_event", event: { type: "message_start", message: { ...message, content: [] } } });
  message.content.forEach((block, index) => {
    if (block.type === "text") {
      emit({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "text", text: "" } } });
      emit({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } } });
    } else if (block.type === "thinking") {
      emit({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } } });
      emit({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } } });
      emit({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } } });
    } else {
      emit({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } } });
      emit({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } } });
    }
    emit({ type: "stream_event", event: { type: "content_block_stop", index } });
  });
  emit({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: message.stop_reason }, usage: message.usage } });
  emit({ type: "stream_event", event: { type: "message_stop" } });
  emit({ type: "assistant", message });
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(env.ANTHROPIC_BASE_URL + path);
    const request = http.request(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fake-token" } }, (response) => {
      const chunks = [];
      response.on("data", (c) => chunks.push(c));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

async function answer(frames) {
  record({ event: "query", frames: frames.length });
  if (modes.has("hang")) {
    const child = spawn("sleep", ["300"], { stdio: "ignore" });
    record({ event: "grandchild", child: child.pid });
    return new Promise(() => {});
  }
  if (modes.has("crash")) { process.stderr.write("fake crash\n"); process.exit(3); }
  const message = nativeMessage();
  if (modes.has("http") || modes.has("double")) {
    const body = { model: flag("--model"), stream: true, max_tokens: 64, messages: [{ role: "user", content: "x" }], system: [{ type: "text", text: "s" }] };
    const first = await post("/v1/messages", body);
    record({ event: "post", status: first.status });
    if (modes.has("double")) {
      const second = await post("/v1/messages", body);
      record({ event: "post", status: second.status, denied: second.body.includes("TURN_RELAY_CONSUMED") });
    }
    if (modes.has("billing")) emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", isUsingOverage: true } });
    else emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", isUsingOverage: false } });
    emit({ type: "result", subtype: modes.has("tool") ? "error_max_turns" : "success", is_error: false, num_turns: 1 });
    return;
  }
  directStream(message);
  if (modes.has("billing")) emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: true } });
  emit({ type: "result", subtype: modes.has("tool") ? "error_max_turns" : "success", is_error: false, num_turns: 1, usage: message.usage });
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let frames = 0;
for await (const line of lines) {
  if (!line.trim()) continue;
  const frame = JSON.parse(line);
  if (frame.type === "control_request") {
    emit({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: { models: CATALOG } } });
    continue;
  }
  if (discovery) continue;
  frames += 1;
  if (frame.shouldQuery === false) { emit({ type: "result", subtype: "success", is_error: false, num_turns: 0 }); continue; }
  await answer(frames);
}
process.exit(0);
