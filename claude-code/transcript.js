/**
 * Harness messages to Claude Code's native frames, and the request body extras.
 *
 * The harness keeps the conversation. Each turn replays it to a Claude Code process as stream-json frames
 * (history frames carry `shouldQuery: false`, so only the last one is answered).
 */
import { claudeToolName, TOOL_PREFIX } from "./tool-names.js";
import { ClaudeCodeError, CODES } from "./errors.js";

export const REPLAY_VERSION = 1;

function sanitizeSurrogates(text) {
  return text.replace(/[\uD800-\uDFFF]/gu, "�");
}

function clone(value) {
  return structuredClone(value);
}

function parseArguments(raw) {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The visible text and tool calls of one assistant message, used to decide whether a saved native copy is still valid. */
export function assistantProjection(message) {
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  const toolCalls = message.content
    .filter((block) => block.type === "tool-call")
    .map((block) => ({ id: block.id, name: block.name, input: parseArguments(block.arguments) }));
  return { text, toolCalls };
}

/** The carrier a previous turn of this route saved in the message's replay state, if it is one. */
function replayCarrier(message) {
  const state = message.source?.replayState;
  const candidate = state && typeof state === "object" && state.response !== undefined ? state.response : state;
  if (!candidate || typeof candidate !== "object") return undefined;
  return candidate.version === REPLAY_VERSION && candidate.message && candidate.projection ? candidate : undefined;
}

/** The replay state to attach to a finished assistant message. */
export function makeReplayState(nativeMessage, projection, initialUserPrefix, initialSystemMessages) {
  return {
    response: {
      version: REPLAY_VERSION,
      message: clone(nativeMessage),
      projection,
      ...(initialUserPrefix ? { initialUserPrefix: clone(initialUserPrefix) } : {}),
      ...(initialSystemMessages ? { initialSystemMessages: clone(initialSystemMessages) } : {}),
    },
  };
}

function replayMetadata(messages, key) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const value = replayCarrier(message)?.[key];
    if (value) return clone(value);
  }
  return undefined;
}

export function getInitialUserPrefix(messages) {
  return replayMetadata(messages, "initialUserPrefix");
}

export function getInitialSystemMessages(messages) {
  return replayMetadata(messages, "initialSystemMessages");
}

/** Text of a harness content block list. Images and files are named, never sent: the route declares text-only input. */
function blockText(block) {
  switch (block.type) {
    case "text": return block.text;
    case "image": return `[image${block.attachment?.name ? `: ${block.attachment.name}` : ""} omitted: this route takes text only]`;
    case "file": return `[file${block.attachment?.name ? `: ${block.attachment.name}` : ""}]`;
    default: return "";
  }
}

function userContent(content) {
  const blocks = [];
  for (const block of content) {
    const text = blockText(block);
    if (text) blocks.push({ type: "text", text: sanitizeSurrogates(text) });
  }
  return blocks;
}

function toolResultContent(message) {
  return sanitizeSurrogates(message.content.map(blockText).filter(Boolean).join("\n"));
}

function canonicalAssistantContent(message) {
  const blocks = [];
  for (const block of message.content) {
    if (block.type === "text" && block.text.trim()) {
      blocks.push({ type: "text", text: sanitizeSurrogates(block.text) });
    } else if (block.type === "tool-call") {
      blocks.push({
        type: "tool_use",
        id: block.id,
        name: `${TOOL_PREFIX}${claudeToolName(block.name)}`,
        input: parseArguments(block.arguments),
      });
    }
  }
  return blocks;
}

function assistantContent(message) {
  const carrier = replayCarrier(message);
  if (carrier && JSON.stringify(assistantProjection(message)) === JSON.stringify(carrier.projection)) {
    return clone(carrier.message.content);
  }
  // Reasoning blocks carry no signature in the harness vocabulary, so only the saved native copy can replay them.
  return canonicalAssistantContent(message);
}

/** Native frames for the conversation. The system prompt travels separately. */
export function prepareFrames(messages) {
  const frames = [];
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") continue;
    let role;
    let blocks;
    if (message.role === "user") {
      role = "user";
      blocks = userContent(message.content);
    } else if (message.role === "assistant") {
      role = "assistant";
      blocks = assistantContent(message);
    } else if (message.role === "tool") {
      role = "user";
      blocks = [{
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: toolResultContent(message),
        is_error: message.isError === true,
      }];
    } else {
      continue;
    }
    if (blocks.length === 0) continue;
    const previous = frames.at(-1);
    if (role === "user" && previous?.type === "user") previous.message.content.push(...blocks);
    else frames.push({ type: role, message: { role, content: blocks } });
  }

  const final = frames.at(-1);
  if (!final || final.type !== "user" || final.message.content.length === 0) {
    throw new ClaudeCodeError("Claude Code history must end in a non-empty user or tool-result message", CODES.FAILED);
  }
  for (let index = 0; index < frames.length - 1; index++) {
    if (frames[index].type === "user") frames[index].shouldQuery = false;
  }
  return frames;
}

/** The system prompt text: the one-shot `system` option, then the leading system message. */
export function systemPromptText(options) {
  const parts = [];
  if (typeof options.system === "string" && options.system.trim()) parts.push(options.system);
  const lead = options.messages.find((message) => message.role === "system");
  if (lead) {
    const text = lead.content.map(blockText).join("");
    if (text.trim()) parts.push(text);
  }
  return parts.join("\n\n");
}

function withoutNullVariant(schema) {
  if (Array.isArray(schema)) return schema.map(withoutNullVariant);
  if (!schema || typeof schema !== "object") return schema;
  const output = {};
  for (const [key, value] of Object.entries(schema)) output[key] = withoutNullVariant(value);
  if (Array.isArray(output.type) && output.type.includes("null")) {
    const remaining = output.type.filter((value) => value !== "null");
    output.type = remaining.length === 1 ? remaining[0] : remaining;
  }
  if (Array.isArray(output.anyOf)) {
    const nonNull = output.anyOf.filter((branch) => !(branch && typeof branch === "object" && branch.type === "null"));
    if (nonNull.length === 1 && nonNull.length !== output.anyOf.length) {
      const replacement = nonNull[0];
      delete output.anyOf;
      if (replacement && typeof replacement === "object") Object.assign(output, replacement);
    }
  }
  return output;
}

export function normalizeInputSchema(schema) {
  const normalized = withoutNullVariant(schema ?? {});
  for (const key of ["oneOf", "allOf", "anyOf"]) delete normalized[key];
  if (!normalized.type) normalized.type = "object";
  if (normalized.type === "object" && (!normalized.properties || typeof normalized.properties !== "object")) {
    normalized.properties = {};
  }
  return normalized;
}

/** Tool declarations for the inert MCP inventory (`manifest`), the request body (`nativeTools`) and the name map. */
export function prepareTools(tools = []) {
  const names = new Map();
  const real = new Set();
  const manifest = [];
  const nativeTools = [];
  for (const tool of tools) {
    if (!tool.name || real.has(tool.name)) {
      throw new ClaudeCodeError(`Claude Code tool names must be unique and non-empty; "${tool.name}" is offered twice or empty`, CODES.FAILED);
    }
    const wire = claudeToolName(tool.name);
    const clash = names.get(wire);
    if (clash !== undefined) {
      throw new ClaudeCodeError(`Tools "${clash}" and "${tool.name}" map to the same Claude tool name "${wire}"; rename one of them`, CODES.FAILED);
    }
    real.add(tool.name);
    names.set(wire, tool.name);
    const schema = normalizeInputSchema(tool.parameters);
    manifest.push({ name: wire, description: tool.description, inputSchema: schema });
    nativeTools.push({ name: `${TOOL_PREFIX}${wire}`, description: tool.description, input_schema: schema });
  }
  return { manifest, nativeTools, names };
}

/**
 * Extra request-body fields. With a reasoning effort the model thinks (adaptive where the CLI reports it);
 * without one thinking is disabled, which also makes native clear-thinking edits invalid, so they are emptied.
 */
export function buildExtraBody(nativeTools, { maxTokens, reasoningEffort, adaptive = true } = {}) {
  const body = { tools: nativeTools };
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  if (reasoningEffort) {
    if (adaptive) body.thinking = { type: "adaptive" };
    body.output_config = { effort: reasoningEffort };
  } else {
    body.thinking = { type: "disabled" };
    body.context_management = { edits: [] };
  }
  return body;
}
