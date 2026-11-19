/**
 * Streaming one turn: Server-Sent Events from the provider to the harness's StreamChunk vocabulary. Text, thinking and
 * tool calls are separate blocks; a tool call whose arguments arrive in pieces is assembled and ends only when the
 * provider says it is complete (its arguments are then sent as one delta, whole, so they are valid JSON).
 */
import { AntigravityError, CODES, providerMessage } from "./errors.js";
import { assistantProjection, makeReplayState } from "./request.js";

const STOP = { STOP: "stop", MAX_TOKENS: "max-tokens" };
const asArgs = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

export class Translator {
  constructor(ToolCallId = (id) => id) {
    this.ToolCallId = ToolCallId;
    this.blocks = []; // finished harness blocks, in order
    this.parts = []; // the provider's own parts, kept for replay
    this.current = undefined; // {kind, index, text, signature}
    this.pending = undefined; // {index, id, name, args, part}
    this.nextIndex = 0;
    this.finishReason = undefined;
    this.usage = undefined;
    this.sawContent = false;
  }

  closeCurrent(chunks) {
    const cur = this.current;
    if (!cur) return;
    const block = { type: cur.kind, text: cur.text };
    this.blocks.push(block);
    if (cur.kind === "text") this.parts.push({ text: cur.text, ...(cur.signature ? { thoughtSignature: cur.signature } : {}) });
    else this.parts.push({ text: cur.text, thought: true, ...(cur.signature ? { thoughtSignature: cur.signature } : {}) });
    chunks.push({ type: "block-end", index: cur.index, block });
    this.current = undefined;
  }

  closePending(chunks) {
    const p = this.pending;
    if (!p) return;
    const block = { type: "tool-call", id: this.ToolCallId(p.id), name: p.name, arguments: JSON.stringify(p.args) };
    this.blocks.push(block);
    this.parts.push({ functionCall: { id: p.id, name: p.name, args: p.args }, ...(p.signature ? { thoughtSignature: p.signature } : {}) });
    chunks.push({ type: "tool-call-delta", index: p.index, id: block.id, argumentsDelta: block.arguments });
    chunks.push({ type: "block-end", index: p.index, block });
    this.pending = undefined;
  }

  text(part, chunks) {
    const kind = part.thought === true ? "reasoning" : "text";
    this.closePending(chunks);
    if (!this.current || this.current.kind !== kind) {
      this.closeCurrent(chunks);
      this.current = { kind, index: this.nextIndex++, text: "", signature: undefined };
      chunks.push({ type: "block-start", index: this.current.index, blockType: kind });
    }
    const delta = part.text ?? "";
    this.current.text += delta;
    if (part.thoughtSignature) this.current.signature = part.thoughtSignature;
    if (delta) chunks.push({ type: kind === "text" ? "text-delta" : "reasoning-delta", index: this.current.index, text: delta });
  }

  functionCall(part, chunks) {
    const fc = part.functionCall;
    this.closeCurrent(chunks);
    const piece = asArgs(fc.args);
    // A continuation carries the id of the call it extends (or none): its pieces merge into the call in progress.
    if (!this.pending || (fc.id !== undefined && fc.id !== this.pending.id)) {
      this.closePending(chunks);
      if (typeof fc.name !== "string" || !fc.name) throw new AntigravityError("Antigravity sent a tool call with no name", CODES.PROTOCOL);
      this.pending = { index: this.nextIndex++, id: fc.id ?? `call_${this.blocks.length}`, name: fc.name, args: {}, signature: part.thoughtSignature };
      chunks.push({ type: "block-start", index: this.pending.index, blockType: "tool-call" });
      chunks.push({ type: "tool-call-delta", index: this.pending.index, id: this.ToolCallId(this.pending.id), name: fc.name, argumentsDelta: "" });
    }
    Object.assign(this.pending.args, piece);
    if (fc.willContinue !== true) this.closePending(chunks);
  }

  /** One parsed provider event -> harness chunks. */
  chunk(raw) {
    const chunks = [];
    if (raw.error) {
      const status = typeof raw.error.code === "number" ? raw.error.code : undefined;
      const limited = status === 429 || raw.error.status === "RESOURCE_EXHAUSTED";
      throw new AntigravityError(`Antigravity reported an error mid-stream${status ? ` (${status})` : ""}: ${providerMessage(JSON.stringify({ error: raw.error }))}`, limited ? CODES.RATE_LIMITED : CODES.HTTP, { status });
    }
    const data = raw.response ?? raw;
    const candidate = data.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall) { this.sawContent = true; this.functionCall(part, chunks); }
      else if (part.text !== undefined) { this.sawContent = true; this.text(part, chunks); }
    }
    if (candidate?.finishReason) this.finishReason = candidate.finishReason;
    const u = data.usageMetadata;
    if (u) {
      const cached = u.cachedContentTokenCount ?? 0;
      const thoughts = u.thoughtsTokenCount ?? 0;
      const input = (u.promptTokenCount ?? 0) - cached;
      const output = (u.candidatesTokenCount ?? 0) + thoughts;
      this.usage = { inputTokens: input, outputTokens: output, totalTokens: u.totalTokenCount ?? input + output + cached, cacheReadTokens: cached, cacheWriteTokens: 0, reasoningTokens: thoughts };
    }
    return chunks;
  }

  /** Close open blocks, then usage and the finish. Throws a named error when the stream ended without a finish reason. */
  finish() {
    const chunks = [];
    this.closeCurrent(chunks);
    this.closePending(chunks);
    if (!this.finishReason) throw new AntigravityError(`Antigravity ended the stream without a finish reason${this.sawContent ? " after a partial reply" : " and without any reply"}; the connection was probably cut. Try again`, CODES.PROTOCOL);
    const hasTool = this.blocks.some((b) => b.type === "tool-call");
    const mapped = STOP[this.finishReason];
    if (!mapped) throw new AntigravityError(`Antigravity stopped the reply with "${this.finishReason}" (not a normal end)`, CODES.PROTOCOL);
    if (this.usage) chunks.push({ type: "usage", usage: this.usage });
    const kind = hasTool && mapped === "stop" ? "tool-calls" : mapped;
    chunks.push({ type: "finish", reason: { kind }, replayState: makeReplayState(this.parts, assistantProjection({ content: this.blocks })) });
    return chunks;
  }
}

/** Split an SSE byte stream into JSON data payloads. A line that is not valid JSON is a named error, never skipped. */
/** One SSE line longer than this is refused (16 MiB). */
export const SSE_LINE_MAX = 16 * 1024 * 1024;

export async function* sseData(chunks, maxLine = SSE_LINE_MAX) {
  let buffer = "";
  const decoder = new TextDecoder();
  const parse = (line) => {
    if (!line.startsWith("data:")) return undefined;
    const json = line.slice(5).trim();
    if (!json || json === "[DONE]") return undefined;
    try { return JSON.parse(json); } catch { throw new AntigravityError("Antigravity sent a stream event that is not valid JSON", CODES.PROTOCOL); }
  };
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const parsed = parse(buffer.slice(0, at).replace(/\r$/, ""));
      buffer = buffer.slice(at + 1);
      if (parsed) yield parsed;
    }
    if (buffer.length > maxLine) throw new AntigravityError(`Antigravity sent a stream line longer than ${maxLine} characters; refusing to buffer more`, CODES.PROTOCOL);
  }
  buffer += decoder.decode();
  if (buffer) { const parsed = parse(buffer); if (parsed) yield parsed; }
}
