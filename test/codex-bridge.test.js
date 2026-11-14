// Codex bridge: Responses request <-> claude-code module translation, and the generated Codex config.
import test from "node:test";
import assert from "node:assert/strict";
import { buildOutput, configToml, translateRequest } from "../codex-bridge/bridge.mjs";

const msg = (role, text) => ({ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });

test("instructions and leading developer messages become the system prompt; hosted tools are not offered", () => {
  const out = translateRequest({
    instructions: "base",
    input: [msg("developer", "dev rules"), msg("user", "env"), msg("user", "task")],
    tools: [
      { type: "function", name: "exec_command", description: "run", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
      { type: "namespace", name: "multi_agent_v1", tools: [] },
      { type: "web_search" },
    ],
  });
  assert.equal(out.system, "base\n\ndev rules");
  assert.deepEqual(out.messages.map((m) => [m.role, m.content[0].text]), [["user", "env"], ["user", "task"]]);
  assert.deepEqual(out.tools.map((t) => t.name), ["exec_command"]);
  assert.deepEqual(out.skipped, ["multi_agent_v1", "web_search"]);
});

test("a tool round trip replays the native message carried in the reasoning item", () => {
  const replayState = { response: { version: 1, message: { content: [{ type: "thinking", thinking: "t", signature: "s" }] }, projection: {} } };
  const first = buildOutput([
    { type: "block-end", index: 0, block: { type: "reasoning", text: "t" } },
    { type: "block-end", index: 1, block: { type: "text", text: "looking" } },
    { type: "block-end", index: 2, block: { type: "tool-call", id: "toolu_1", name: "exec_command", arguments: '{"cmd":"ls"}' } },
    { type: "usage", usage: { inputTokens: 2, cacheReadTokens: 100, cacheWriteTokens: 30, outputTokens: 7, reasoningTokens: 1 } },
    { type: "finish", reason: { kind: "tool-calls" }, replayState },
  ]);
  assert.deepEqual(first.output.map((i) => i.type), ["reasoning", "message", "function_call"]);
  assert.deepEqual(first.usage, {
    input_tokens: 132, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 30 },
    output_tokens: 7, output_tokens_details: { reasoning_tokens: 1 }, total_tokens: 139,
  });
  const next = translateRequest({
    input: [msg("user", "task"), ...first.output, { type: "function_call_output", call_id: "toolu_1", output: "a.py" }],
  });
  assert.deepEqual(next.messages.map((m) => m.role), ["user", "assistant", "tool"]);
  const assistant = next.messages[1];
  assert.deepEqual(assistant.source.replayState, replayState);
  assert.deepEqual(assistant.content, [
    { type: "text", text: "looking" },
    { type: "tool-call", id: "toolu_1", name: "exec_command", arguments: '{"cmd":"ls"}' },
  ]);
  assert.equal(next.messages[2].toolCallId, "toolu_1");
  assert.equal(next.messages[2].content[0].text, "a.py");
});

test("the generated Codex config points at the loopback endpoint and carries no credential", () => {
  const text = configToml({ url: "http://127.0.0.1:1234/v1", model: "m", effort: "medium" });
  assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:1234\/v1"/);
  assert.match(text, /wire_api = "responses"/);
  assert.match(text, /model_reasoning_effort = "medium"/);
  assert.doesNotMatch(text, /api_key|token\s*=/i);
});
