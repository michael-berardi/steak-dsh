/** Harness messages -> Cloud Code Assist request. Pure: no I/O. */
import { randomUUID } from "node:crypto";
import { AntigravityError, CODES } from "./errors.js";

export const REPLAY_VERSION = 1;
/** Thinking budget in tokens for each harness effort level. */
const LEVEL_BUDGET = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 32768 };
/** The effort levels a thinking model is offered, lowest first. */
export const EFFORT_LEVELS = Object.keys(LEVEL_BUDGET);

const sanitize = (text) => String(text).replace(/[\uD800-\uDFFF]/gu, "�");

function parseArguments(raw) {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** Text of a harness content block. Images and files are named, never sent: the route declares text-only input. */
function blockText(block) {
  switch (block.type) {
    case "text": return block.text;
    case "image": return `[image${block.attachment?.name ? `: ${block.attachment.name}` : ""} omitted: this route takes text only]`;
    case "file": return `[file${block.attachment?.name ? `: ${block.attachment.name}` : ""}]`;
    default: return "";
  }
}

/** The visible text and tool calls of one assistant message, used to decide whether a saved native copy is still valid. */
export function assistantProjection(message) {
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const toolCalls = message.content.filter((b) => b.type === "tool-call").map((b) => ({ id: b.id, name: b.name, input: parseArguments(b.arguments) }));
  return { text, toolCalls };
}

function replayCarrier(message) {
  const state = message.source?.replayState;
  const candidate = state && typeof state === "object" && state.response !== undefined ? state.response : state;
  return candidate && typeof candidate === "object" && candidate.version === REPLAY_VERSION && Array.isArray(candidate.parts) && candidate.projection ? candidate : undefined;
}

export function makeReplayState(parts, projection) {
  return { response: { version: REPLAY_VERSION, parts: structuredClone(parts), projection } };
}

function push(contents, role, parts) {
  if (parts.length === 0) return;
  const last = contents.at(-1);
  // The API wants alternating turns, and all the answers to one round of tool calls in one user turn.
  if (last && last.role === role) last.parts.push(...parts);
  else contents.push({ role, parts });
}

export function buildContents(messages) {
  const contents = [];
  const names = new Map();
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") continue;
    if (message.role === "user") {
      push(contents, "user", message.content.flatMap((b) => { const t = blockText(b); return t ? [{ text: sanitize(t) }] : []; }));
    } else if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "tool-call") names.set(block.id, block.name);
      const carrier = replayCarrier(message);
      if (carrier && JSON.stringify(assistantProjection(message)) === JSON.stringify(carrier.projection)) {
        push(contents, "model", structuredClone(carrier.parts));
        continue;
      }
      // Reasoning carries no signature in the harness vocabulary, so only a saved copy can replay it; it is not sent.
      push(contents, "model", message.content.flatMap((b) => {
        if (b.type === "text" && b.text.trim()) return [{ text: sanitize(b.text) }];
        if (b.type === "tool-call") return [{ functionCall: { id: b.id, name: b.name, args: parseArguments(b.arguments) } }];
        return [];
      }));
    } else if (message.role === "tool") {
      const name = names.get(message.toolCallId);
      if (name === undefined) throw new AntigravityError(`A tool result answers call "${message.toolCallId}", which no earlier assistant message made; the history cannot be sent`, CODES.PROTOCOL);
      const text = sanitize(message.content.map(blockText).filter(Boolean).join("\n"));
      push(contents, "user", [{ functionResponse: { id: message.toolCallId, name, response: message.isError === true ? { error: text } : { output: text } } }]);
    }
  }
  return contents;
}

export function systemText(options) {
  const parts = [];
  if (typeof options.system === "string" && options.system.trim()) parts.push(options.system);
  const lead = options.messages.find((m) => m.role === "system");
  if (lead) { const text = lead.content.map(blockText).join(""); if (text.trim()) parts.push(text); }
  return parts.join("\n\n");
}

/** The request envelope for one turn. `row` is the provider's own entry for the model. */
export function buildRequest(options, row, projectId, identity = { userAgent: "steak-dsh-antigravity", requestType: "agent" }) {
  const contents = buildContents(options.messages);
  if (contents.length === 0 || contents.at(-1).role !== "user") throw new AntigravityError("The history must end in a user or tool-result message; there is nothing to answer", CODES.UNSUPPORTED);
  const generationConfig = { maxOutputTokens: Math.min(options.maxTokens ?? row.maxTokens, row.maxTokens) };
  if (options.reasoningEffort) {
    const effort = String(options.reasoningEffort);
    if (!row.reasoning) throw new AntigravityError(`Model ${row.id} does not support thinking (the provider lists it without thinking), so effort "${effort}" cannot be applied. Run without an effort`, CODES.UNSUPPORTED);
    if (!(effort in LEVEL_BUDGET)) throw new AntigravityError(`Reasoning effort "${effort}" is not one this route knows (${Object.keys(LEVEL_BUDGET).join(", ")})`, CODES.UNSUPPORTED);
    generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: LEVEL_BUDGET[effort] };
  }
  const request = { contents, generationConfig };
  const system = systemText(options);
  if (system) request.systemInstruction = { role: "user", parts: [{ text: system }] };
  const tools = options.tools ?? [];
  const seen = new Set();
  for (const tool of tools) {
    if (!tool.name || seen.has(tool.name)) throw new AntigravityError(`Tool names must be unique and non-empty; "${tool.name}" is offered twice or empty`, CODES.PROTOCOL);
    seen.add(tool.name);
  }
  if (tools.length) request.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters ?? { type: "object", properties: {} } })) }];
  if (options.sessionId !== undefined) request.sessionId = String(options.sessionId);
  return { project: projectId, model: row.id, request, requestType: identity.requestType, userAgent: identity.userAgent, requestId: `steak-dsh-${randomUUID()}` };
}
