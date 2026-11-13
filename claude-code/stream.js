/**
 * Claude Code's native stream (Anthropic message events) to the harness's StreamChunk vocabulary.
 */
import { describeUsageCreditsRejection } from "./billing.js";
import { ClaudeCodeError, CODES } from "./errors.js";
import { harnessToolName } from "./tool-names.js";
import { assistantProjection, makeReplayState } from "./transcript.js";

/** Anthropic stop reason to a harness finish reason kind, or an error for the ones that are not completions. */
export function mapStopReason(reason) {
  switch (reason) {
    case "end_turn":
    case "pause_turn":
    case "stop_sequence":
      return { kind: "stop" };
    case "max_tokens":
    case "model_context_window_exceeded":
      return { kind: "max-tokens" };
    case "tool_use":
      return { kind: "tool-calls" };
    case "refusal":
      return { error: "The model refused to complete the request" };
    case "sensitive":
      return { error: "Provider stopped with: sensitive" };
    default:
      return { error: `Unhandled Claude Code stop reason: ${reason ?? "missing"}` };
  }
}

/** Disjoint token counts: the API's input_tokens already excludes the cached parts. */
export function mapUsage(usage) {
  const input = Number(usage?.input_tokens) || 0;
  const output = Number(usage?.output_tokens) || 0;
  const cacheRead = Number(usage?.cache_read_input_tokens) || 0;
  const cacheWrite = Number(usage?.cache_creation_input_tokens) || 0;
  const reasoning = usage?.output_tokens_details?.thinking_tokens;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output + cacheRead + cacheWrite,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    ...(typeof reasoning === "number" ? { reasoningTokens: reasoning } : {}),
  };
}

function parseJsonString(raw) {
  try { return JSON.parse(raw); } catch { return undefined; }
}

/** The harness block for one finished native block. */
function harnessBlock(native, toolNames) {
  switch (native.type) {
    case "text": return { type: "text", text: native.text ?? "" };
    case "thinking": return { type: "reasoning", text: native.thinking ?? "" };
    case "redacted_thinking": return { type: "reasoning", text: "[Reasoning redacted]" };
    case "tool_use":
      return { type: "tool-call", id: native.id, name: harnessToolName(native.name, toolNames), arguments: JSON.stringify(native.input ?? {}) };
    default: return undefined;
  }
}

/** One translator per request. `event()` takes native stream events and returns chunks; `finish()` closes the turn. */
export class EventTranslator {
  constructor(toolNames, ToolCallId = (id) => id) {
    this.toolNames = toolNames;
    this.ToolCallId = ToolCallId;
    this.byNative = new Map();
    this.blocks = [];
    this.sawContentEvent = false;
  }

  event(event) {
    const chunks = [];
    switch (event.type) {
      case "content_block_start": this.start(event.index, event.content_block, chunks); break;
      case "content_block_delta": this.delta(event.index, event.delta, chunks); break;
      case "content_block_stop": this.stop(event.index, chunks); break;
      default: break;
    }
    return chunks;
  }

  start(nativeIndex, native, chunks) {
    this.sawContentEvent = true;
    const index = this.blocks.length;
    const entry = { index, native, text: "", partialJson: "", signature: "", done: false };
    if (native.type === "text") { entry.kind = "text"; entry.text = native.text ?? ""; }
    else if (native.type === "thinking") { entry.kind = "reasoning"; entry.text = native.thinking ?? ""; }
    else if (native.type === "redacted_thinking") { entry.kind = "reasoning"; entry.text = "[Reasoning redacted]"; }
    else if (native.type === "tool_use") {
      entry.kind = "tool-call";
      entry.name = harnessToolName(native.name, this.toolNames);
      entry.id = native.id;
    } else return;
    this.byNative.set(nativeIndex, entry);
    this.blocks.push(entry);
    chunks.push({ type: "block-start", index, blockType: entry.kind });
    if (entry.kind === "tool-call") {
      chunks.push({ type: "tool-call-delta", index, id: this.ToolCallId(entry.id), name: entry.name, argumentsDelta: "" });
    } else if (entry.text && native.type !== "redacted_thinking") {
      chunks.push({ type: entry.kind === "text" ? "text-delta" : "reasoning-delta", index, text: entry.text });
    }
  }

  delta(nativeIndex, delta, chunks) {
    const entry = this.byNative.get(nativeIndex);
    if (!entry || entry.done) return;
    if (delta.type === "text_delta" && entry.kind === "text") {
      entry.text += delta.text;
      chunks.push({ type: "text-delta", index: entry.index, text: delta.text });
    } else if (delta.type === "thinking_delta" && entry.kind === "reasoning") {
      entry.text += delta.thinking;
      chunks.push({ type: "reasoning-delta", index: entry.index, text: delta.thinking });
    } else if (delta.type === "signature_delta" && entry.kind === "reasoning") {
      entry.signature += delta.signature;
    } else if (delta.type === "input_json_delta" && entry.kind === "tool-call") {
      entry.partialJson += delta.partial_json;
      chunks.push({ type: "tool-call-delta", index: entry.index, id: this.ToolCallId(entry.id), argumentsDelta: delta.partial_json });
    }
  }

  stop(nativeIndex, chunks) {
    const entry = this.byNative.get(nativeIndex);
    if (!entry || entry.done) return;
    entry.done = true;
    let block;
    if (entry.kind === "text") block = { type: "text", text: entry.text };
    else if (entry.kind === "reasoning") block = { type: "reasoning", text: entry.text };
    else {
      const raw = entry.partialJson.trim() ? entry.partialJson : JSON.stringify(entry.native.input ?? {});
      block = { type: "tool-call", id: this.ToolCallId(entry.id), name: entry.name, arguments: raw };
    }
    entry.block = block;
    chunks.push({ type: "block-end", index: entry.index, block });
  }

  /**
   * Close the turn: verify the incremental stream against the authoritative final message (or emit it whole when no
   * incremental events arrived), then yield usage and the terminal finish with the replay state.
   */
  finish(message, usage, { initialUserPrefix, initialSystemMessages, result } = {}) {
    const chunks = [];
    const authoritative = message.content.map((native) => harnessBlock(native, this.toolNames)).filter(Boolean);
    if (!this.sawContentEvent) {
      authoritative.forEach((block, index) => {
        chunks.push({ type: "block-start", index, blockType: block.type });
        if (block.type === "text") chunks.push({ type: "text-delta", index, text: block.text });
        else if (block.type === "reasoning") chunks.push({ type: "reasoning-delta", index, text: block.text });
        else chunks.push({ type: "tool-call-delta", index, id: this.ToolCallId(block.id), name: block.name, argumentsDelta: block.arguments });
        chunks.push({ type: "block-end", index, block: block.type === "tool-call" ? { ...block, id: this.ToolCallId(block.id) } : block });
      });
    } else {
      const streamed = this.blocks.map((entry) => entry.block).filter(Boolean);
      const comparable = (blocks) => JSON.stringify(blocks.map((block) => block.type === "tool-call"
        ? { type: block.type, id: String(block.id), name: block.name, arguments: parseJsonString(block.arguments) }
        : block));
      if (comparable(streamed) !== comparable(authoritative)) {
        throw new ClaudeCodeError("Claude Code final response differs from its incremental stream", CODES.FAILED);
      }
    }
    const mapped = mapStopReason(message.stop_reason);
    if (mapped.error) throw new ClaudeCodeError(mapped.error, CODES.FAILED);
    // The CLI prices each request itself (list price, also on a plan login): passed on so a UI can total it.
    const cost = result?.total_cost_usd;
    chunks.push({ type: "usage", usage: { ...mapUsage(usage), ...(Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}) } });
    const projection = assistantProjection({ content: authoritative });
    chunks.push({
      type: "finish",
      reason: { kind: mapped.kind },
      replayState: makeReplayState(message, projection, initialUserPrefix, initialSystemMessages),
    });
    return chunks;
  }
}

/** One actionable message: usage-credit rejections are rewritten, context overflow is tagged. */
export function normalizeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  const credits = describeUsageCreditsRejection(message);
  if (credits) return { message: credits, code: CODES.BILLING };
  if (/prompt is too long|context(?:_| )length|context window exceeded|too many input tokens/iu.test(message)) {
    return { message: `context_length_exceeded: ${message}`, code: "CONTEXT_WINDOW_EXCEEDED" };
  }
  return { message, code: error?.code };
}
