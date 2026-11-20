#!/usr/bin/env node
// A fake ACP agent for the agy ACP route tests: newline JSON-RPC over stdio, exactly the ACP v1 shape.
// FAKE_ACP_MODE: text | tool | parallel | auth | cancel | options | models. FAKE_ACP_LOG: one JSON line per event.
// It never touches an agy credential; the MCP call goes to the loopback bridge the client advertises in session/new.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_ACP_MODE ?? "text";
const log = (event) => { if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify(event)}\n`); };
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });
const update = (sessionId, value) => { log({ event: "update", sessionId, value }); out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } }); };
const text = (sessionId, value) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: value }] });
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (argv.includes("--help")) { log({ event: "help", argv }); process.stdout.write("Usage: agy acp [flags]\n  --agent <name>\n  --process-per-session\n  --disable-telemetry\n"); process.exit(0); }
if (argv[0] === "models") {
  log({ event: "models", argv });
  process.stderr.write("Fetching available models...\n");
  process.stdout.write("gemini-4-neon-high Gemini 4 Neon (High)\ngemini-4-neon-low Gemini 4 Neon (Low)\n");
  process.exit(0);
}
log({ event: "launch", argv, pid: process.pid });
for (const flag of ["--process-per-session", "--disable-telemetry", "--log-file", "--agent"]) {
  if (!argv.includes(flag)) { process.stderr.write(`fake acp: missing ${flag}\n`); process.exit(9); }
}
if (!argv.some((value) => value === "steak-dsh-bridge")) { process.stderr.write("fake acp: no minimal bridge agent\n"); process.exit(9); }

const MODEL_OPTIONS = [
  { value: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
  { value: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
];
const EFFORT_OPTIONS = [
  { value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" },
  { value: "extra", name: "Extra" }, { value: "max", name: "Max" },
];
const configOptions = (model = "gemini-4-neon-high", effort = "medium") => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: MODEL_OPTIONS },
  { id: "thought_level", name: "Thinking level", type: "select", currentValue: effort, options: EFFORT_OPTIONS },
];

let mcp;
let sessionId;
let currentModel = "gemini-4-neon-high";
let currentEffort = "medium";
let promptRequest;
let sessionCounter = 0;

async function callBridge(name, args) {
  const response = await fetch(mcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...Object.fromEntries(mcp.headers.map((h) => [h.name, h.value])) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 77, method: "tools/call", params: { name, arguments: args } }),
  });
  const answer = await response.json();
  log({ event: "bridge", status: response.status, name, args, result: answer.result });
  return answer;
}

async function runPrompt(id, params) {
  promptRequest = id;
  const prompt = params.prompt?.[0]?.text ?? "";
  log({ event: "prompt", prompt, sessionId: params.sessionId, model: currentModel, effort: currentEffort });
  update(sessionId, { sessionUpdate: "usage_update", used: 180_000, size: 1_000_000 });
  if (mode === "cancel") { await settle(300); return; }
  if (mode === "options") {
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: [{ type: "text", text: "thinking " }] });
    text(sessionId, "chosen from options ");
  }
  if (mode === "tool") {
    const toolName = process.env.FAKE_ACP_TOOL ?? "echo";
    const toolArgs = process.env.FAKE_ACP_ARGS ? JSON.parse(process.env.FAKE_ACP_ARGS) : { text: prompt };
    const initial = await callBridge(toolName, toolArgs);
    text(sessionId, `bridge said ${initial.result?.content?.[0]?.text ?? "nothing"}`);
  }
  if (mode === "parallel") {
    const [a, b] = await Promise.all([
      callBridge("echo", { text: "one" }),
      callBridge("echo2", { text: "two" }),
    ]);
    text(sessionId, `parallel ${a.result?.content?.[0]?.text ?? "?"} / ${b.result?.content?.[0]?.text ?? "?"}`);
  }
  text(sessionId, "answer from acp\n");
  await settle(20);
  reply(id, { stopReason: "end_turn" });
  promptRequest = undefined;
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  log({ event: "in", method: message.method, id: message.id, params: message.params, cancel: message.params?.id });
  if (message.id !== undefined && message.method) {
    switch (message.method) {
      case "initialize":
        reply(message.id, { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true }, loadSession: false }, serverInfo: { name: "fake-agy-acp", version: "1" } });
        break;
      case "session/new":
        if (mode === "auth") { err(message.id, -32000, "Authentication required"); break; }
        mcp = message.params?.mcpServers?.[0];
        if (mcp?.type !== "http" || !String(mcp.url).startsWith("http://127.0.0.1:") || !mcp.headers?.some((h) => h.name === "Authorization" && h.value.startsWith("Bearer "))) {
          err(message.id, -32602, "no loopback HTTP MCP server with a bearer token");
          break;
        }
        sessionId = `fake-acp-session-${process.pid}-${++sessionCounter}`;
        log({ event: "mcp", mcp: { ...mcp, headers: [{ name: "Authorization", value: "Bearer [redacted]" }] }, cwd: message.params?.cwd });
        reply(message.id, { sessionId, configOptions: configOptions() });
        break;
      case "session/set_config_option":
        if (message.params.configId === "model") currentModel = message.params.value;
        if (message.params.configId === "thought_level") currentEffort = message.params.value;
        reply(message.id, { configOptions: configOptions(currentModel, currentEffort) });
        break;
      case "session/prompt":
        void runPrompt(message.id, message.params);
        break;
      default:
        err(message.id, -32601, `unknown method ${message.method}`);
    }
    continue;
  }
  if (message.method === "session/cancel" && promptRequest !== undefined) {
    const id = promptRequest;
    promptRequest = undefined;
    reply(id, { stopReason: "cancelled" });
  }
  if (message.method === "$/cancel_request") err(message.params?.id, -32800, "Request cancelled");
}
