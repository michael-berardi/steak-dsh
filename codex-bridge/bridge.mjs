#!/usr/bin/env node
/**
 * Codex CLI on the Claude Code route: a loopback Responses endpoint that runs every request through the same
 * Claude Code module the steak-dsh `claude-code` route uses, on the user's own Claude Code subscription login.
 *
 *   node codex-bridge/bridge.mjs exec -- <codex> exec --json ... "<prompt>"
 *
 * Starts the endpoint on a random loopback port, writes CODEX_HOME/config.toml so Codex's model provider points at
 * it, runs the command, and exits with the command's exit code. Codex keeps the conversation, the tools and the
 * approvals; Claude Code only generates. Credentials stay with Claude Code: nothing here reads, copies or logs them.
 *
 * Translation (Responses API <-> the harness vocabulary the claude-code module takes):
 * - `instructions` and developer messages become the system prompt; user, assistant, function_call and
 *   function_call_output items become user, assistant and tool messages.
 * - Function tools are offered by name; namespaced tools and hosted tools (web search) are not offered.
 * - Each response starts with one reasoning item whose `encrypted_content` carries the native Anthropic message
 *   (signed thinking included). Codex sends it back with the next request, so the transcript replays exactly.
 * - Usage: input_tokens counts all input; cached_tokens is the cache read, cache_write_tokens the cache write.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createClaudeCodeAdapter } from "../claude-code/adapter.js";
import { loadHarness } from "../claude-code/harness.js";

const PROVIDER = "claude-code-bridge";
const KEY_ENV = "CLAUDE_CODE_BRIDGE_TOKEN";

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

function encodeCarrier(replayState) {
  return Buffer.from(JSON.stringify(replayState ?? null), "utf8").toString("base64");
}

function decodeCarrier(value) {
  if (typeof value !== "string" || !value) return undefined;
  try { return JSON.parse(Buffer.from(value, "base64").toString("utf8")) ?? undefined; } catch { return undefined; }
}

/** Responses request body -> { system, messages, tools } in the harness vocabulary. */
export function translateRequest(body) {
  const systemParts = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) systemParts.push(body.instructions);
  const messages = [];
  let assistant; // the assistant message being assembled from consecutive model-side items
  const closeAssistant = () => {
    if (assistant && assistant.content.length) messages.push(assistant);
    assistant = undefined;
  };
  const openAssistant = () => {
    if (!assistant) assistant = { role: "assistant", id: randomUUID(), content: [], source: { kind: "model" } };
    return assistant;
  };
  let n = 0;
  for (const item of Array.isArray(body.input) ? body.input : []) {
    const type = item.type ?? (item.role ? "message" : undefined);
    if (type === "reasoning") {
      closeAssistant(); // every response this bridge returns starts with one reasoning item
      const message = openAssistant();
      const carrier = decodeCarrier(item.encrypted_content);
      if (carrier) message.source = { kind: "model", replayState: carrier };
    } else if (type === "message" && item.role === "assistant") {
      const text = textOf(item.content);
      if (text) openAssistant().content.push({ type: "text", text });
    } else if (type === "function_call") {
      openAssistant().content.push({ type: "tool-call", id: item.call_id, name: item.name, arguments: item.arguments ?? "{}" });
    } else if (type === "function_call_output") {
      closeAssistant();
      const output = typeof item.output === "string" ? item.output : textOf(item.output?.content ?? item.output);
      messages.push({ role: "tool", id: `t${n++}`, toolCallId: item.call_id, content: [{ type: "text", text: output }], source: { kind: "tool" } });
    } else if (type === "message" && (item.role === "developer" || item.role === "system")) {
      const text = textOf(item.content);
      if (text.trim()) {
        if (messages.length === 0) systemParts.push(text);
        else { closeAssistant(); messages.push({ role: "user", id: `u${n++}`, content: [{ type: "text", text }], source: { kind: "user" } }); }
      }
    } else if (type === "message" && item.role === "user") {
      closeAssistant();
      const text = textOf(item.content);
      if (text) messages.push({ role: "user", id: `u${n++}`, content: [{ type: "text", text }], source: { kind: "user" } });
    }
  }
  closeAssistant();
  const tools = [];
  const skipped = [];
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (tool.type === "function" && tool.name) tools.push({ name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? { type: "object", properties: {} } });
    else skipped.push(tool.name ?? tool.type);
  }
  return { system: systemParts.join("\n\n"), messages, tools, skipped };
}

/** Collected adapter chunks -> Responses output items and usage. */
export function buildOutput(chunks) {
  const blocks = [];
  let usage = {};
  let replayState;
  for (const chunk of chunks) {
    if (chunk.type === "block-end") blocks.push(chunk.block);
    else if (chunk.type === "usage") usage = chunk.usage;
    else if (chunk.type === "finish") replayState = chunk.replayState;
  }
  const reasoningText = blocks.filter((b) => b.type === "reasoning").map((b) => b.text).join("\n");
  const output = [{
    type: "reasoning", id: `rs_${randomUUID()}`,
    summary: reasoningText ? [{ type: "summary_text", text: reasoningText }] : [],
    encrypted_content: encodeCarrier(replayState),
  }];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  if (text) output.push({ type: "message", id: `msg_${randomUUID()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
  for (const b of blocks) {
    if (b.type === "tool-call") output.push({ type: "function_call", id: `fc_${randomUUID()}`, call_id: String(b.id), name: b.name, arguments: b.arguments || "{}", status: "completed" });
  }
  const i = usage.inputTokens ?? 0, cr = usage.cacheReadTokens ?? 0, cw = usage.cacheWriteTokens ?? 0, o = usage.outputTokens ?? 0;
  return {
    output,
    usage: {
      input_tokens: i + cr + cw,
      input_tokens_details: { cached_tokens: cr, cache_write_tokens: cw },
      output_tokens: o,
      output_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
      total_tokens: i + cr + cw + o,
    },
  };
}

function sse(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
}

export async function startBridge({ adapter, log = () => {} }) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/responses")) { res.writeHead(404).end(); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableFinished) abort.abort(new Error("client went away")); });
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "bad JSON" } })); return;
    }
    const id = `resp_${randomUUID()}`;
    try {
      const { system, messages, tools, skipped } = translateRequest(body);
      if (skipped.length) log(`codex-bridge: tools not offered on this route: ${skipped.join(", ")}`);
      const collected = [];
      for await (const chunk of adapter.stream({
        provider: "claude-code", model: body.model, system, messages, tools,
        reasoningEffort: body.reasoning?.effort && body.reasoning.effort !== "none" ? body.reasoning.effort : undefined,
        maxTokens: body.max_output_tokens, sessionId: body.prompt_cache_key, signal: abort.signal,
      })) collected.push(chunk);
      const { output, usage } = buildOutput(collected);
      let out = sse("response.created", { response: { id, object: "response", status: "in_progress", model: body.model, output: [] } });
      output.forEach((item, index) => {
        out += sse("response.output_item.added", { output_index: index, item: item.type === "message" ? { ...item, content: [], status: "in_progress" } : item });
        if (item.type === "message") out += sse("response.output_text.delta", { item_id: item.id, output_index: index, content_index: 0, delta: item.content[0].text });
        out += sse("response.output_item.done", { output_index: index, item });
      });
      out += sse("response.completed", { response: { id, object: "response", status: "completed", model: body.model, output, usage } });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }).end(out);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`codex-bridge: request failed: ${message}`);
      const status = /rate.?limit|429|overloaded/i.test(message) ? 429 : 500;
      if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message, code: error?.code } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
}

export function configToml({ url, model, effort }) {
  return [
    `model = ${JSON.stringify(model)}`,
    `model_provider = ${JSON.stringify(PROVIDER)}`,
    ...(effort ? [`model_reasoning_effort = ${JSON.stringify(effort)}`] : []),
    `approval_policy = "never"`,
    `sandbox_mode = "workspace-write"`,
    "",
    `[model_providers.${PROVIDER}]`,
    `name = "Claude Code (subscription login)"`,
    `base_url = ${JSON.stringify(url)}`,
    `env_key = ${JSON.stringify(KEY_ENV)}`,
    `wire_api = "responses"`,
    `request_max_retries = 0`,
    `stream_max_retries = 0`,
    "",
  ].join("\n");
}

async function main(argv) {
  const sep = argv.indexOf("--");
  if (argv[0] !== "exec" || sep < 0 || sep === argv.length - 1) {
    process.stderr.write("usage: bridge.mjs exec [--model <id>] [--effort <level>] -- <codex> exec ...\n" +
      "Needs CODEX_HOME (a private folder: config.toml in it is overwritten).\n");
    return 2;
  }
  const opts = argv.slice(1, sep);
  const get = (flag) => { const i = opts.indexOf(flag); return i >= 0 ? opts[i + 1] : undefined; };
  const model = get("--model");
  const effort = get("--effort");
  const home = process.env.CODEX_HOME;
  if (!model || !home) { process.stderr.write("codex-bridge: --model and CODEX_HOME are required\n"); return 2; }
  const harness = await loadHarness({ entry: "/nonexistent" }); // the module's own adapter contract; no dsh needed
  const log = (message) => process.stderr.write(`${message}\n`);
  const adapter = createClaudeCodeAdapter(harness, {
    env: () => (process.env.CODEX_BRIDGE_CLAUDE_COMMAND ? { ...process.env, STEAK_DSH_CLAUDE_CODE_COMMAND: process.env.CODEX_BRIDGE_CLAUDE_COMMAND } : process.env),
    report: log,
  });
  const { server, url } = await startBridge({ adapter, log });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.toml"), configToml({ url, model, effort }));
  const [command, ...args] = argv.slice(sep + 1);
  const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, [KEY_ENV]: "local-bridge" } });
  const stop = (signal) => child.kill(signal);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const code = await new Promise((resolve) => child.on("exit", (c, s) => resolve(c ?? (s ? 1 : 0))));
  await adapter.close?.();
  server.close();
  return code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => { process.stderr.write(`codex-bridge: ${error.stack ?? error}\n`); process.exit(1); });
}
