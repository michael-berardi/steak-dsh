/**
 * agy's documented stream-json events (init, step_update, result) to the harness's StreamChunk vocabulary.
 *
 * agy runs its own tools. A `tool` step is therefore shown as progress text, never as a harness tool call (the
 * harness would execute it a second time). The answer is the text agy streams in `agent_response` steps.
 */
import { AgyError, CODES, SIGN_IN_HINT, cleanAgyText } from "./errors.js";

const PROGRESS_PARAM_MAX = 120;
const AUTH = /authenticat|sign[ -]?in|signed in|log ?in\b|unauthenticated|credential/i;
const BAD_MODEL = /not recognized as a known model|invalid model selection|unknown model|not available (?:on|for|in) your|does not have access|not entitled/i;
const TIMED_OUT = /timed out|timeout|deadline exceeded/i;

const flat = (text) => cleanAgyText(text).replace(/\s+/g, " ").trim();
const firstLine = (text) => cleanAgyText(text).split("\n").map((l) => l.trim()).find(Boolean) ?? "";

/** Token counts in the harness's disjoint form: agy's input_tokens includes the cached part. */
export function mapUsage(usage) {
  const input = Number(usage?.input_tokens) || 0;
  const output = Number(usage?.output_tokens) || 0;
  const cacheRead = Math.min(Number(usage?.cache_read_tokens) || 0, input);
  const thinking = usage?.thinking_tokens;
  const total = Number(usage?.total_tokens);
  return {
    inputTokens: input - cacheRead,
    outputTokens: output,
    totalTokens: Number.isFinite(total) && total > 0 ? total : input + output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    ...(typeof thinking === "number" ? { reasoningTokens: thinking } : {}),
  };
}

/** One line of progress for a finished agy tool step. */
export function progressLine(step) {
  const info = step.tool_info ?? {};
  const name = info.name ?? step.tool_name ?? "tool";
  const first = Object.values(info.parameters ?? {}).find((v) => typeof v === "string" && v.trim());
  const detail = first ? ` ${flat(first).slice(0, PROGRESS_PARAM_MAX)}` : "";
  const failed = info.error ? ` failed: ${flat(info.error.message ?? info.error.type ?? "error").slice(0, PROGRESS_PARAM_MAX)}` : "";
  return `[agy tool: ${name}${detail}${failed}]`;
}

/**
 * A result whose status is not SUCCESS, as a named error. `model` is the id the run was asked for.
 */
export function errorForResult(result, model) {
  const status = String(result?.status ?? "missing");
  const text = cleanAgyText(result?.error).trim();
  switch (status) {
    case "ERROR": {
      if (AUTH.test(text)) return new AgyError(`agy is not signed in: ${flat(text)}; ${SIGN_IN_HINT}`, CODES.NOT_SIGNED_IN);
      if (BAD_MODEL.test(text)) {
        return new AgyError(`agy: model "${model}" is not available on this plan (agy said: ${flat(firstLine(text))}); run \`steak-dsh models --provider agy\` to see what the plan offers`, CODES.MODEL_UNAVAILABLE);
      }
      if (TIMED_OUT.test(text)) return new AgyError(`agy timed out: ${flat(text)}`, CODES.TIMEOUT);
      return new AgyError(`agy failed (ERROR): ${flat(text) || "no error text"}`, CODES.FAILED);
    }
    case "CANCELED": return new AgyError(`agy run cancelled (CANCELED)${text ? `: ${flat(text)}` : ""}`, CODES.CANCELLED);
    case "INTERRUPTED": return new AgyError(`agy run interrupted (INTERRUPTED)${text ? `: ${flat(text)}` : ""}`, CODES.CANCELLED);
    case "INVALID": return new AgyError(`agy reached an invalid state (INVALID)${text ? `: ${flat(text)}` : ""}`, CODES.INVALID);
    case "WAITING": return new AgyError(`agy ended waiting on input (WAITING)${text ? `: ${flat(text)}` : ""}; headless runs cannot answer it`, CODES.FAILED);
    case "RUNNING": return new AgyError("agy ended without reaching a terminal state (RUNNING)", CODES.FAILED);
    default: return new AgyError(`agy ended with an unknown status "${status}"${text ? `: ${flat(text)}` : ""}`, CODES.FAILED);
  }
}

/** One translator per request. `event()` takes agy events and returns chunks; `finish()` closes the turn. */
export class AgyTranslator {
  constructor(model) {
    this.model = model;
    this.conversationId = undefined;
    this.text = "";
    this.started = false;
    this.lastResponseStep = undefined;
    this.shownTools = new Set();
    this.result = undefined;
  }

  /** Emit `text` into the single text block, opening it first. */
  emit(text, chunks) {
    if (!text) return;
    if (!this.started) { this.started = true; chunks.push({ type: "block-start", index: 0, blockType: "text" }); }
    this.text += text;
    chunks.push({ type: "text-delta", index: 0, text });
  }

  event(event) {
    const chunks = [];
    if (event?.event === "init") {
      this.conversationId = event.conversation_id ?? this.conversationId;
    } else if (event?.event === "step_update" && event.step_update) {
      const step = event.step_update;
      this.conversationId = step.conversation_id || this.conversationId;
      if (step.step_type === "agent_response" && typeof step.text_delta === "string" && step.text_delta) {
        // A new response step after other output starts on its own line.
        if (this.lastResponseStep !== undefined && step.step_index !== this.lastResponseStep && this.text && !this.text.endsWith("\n")) this.emit("\n", chunks);
        this.lastResponseStep = step.step_index;
        this.emit(step.text_delta, chunks);
      } else if (step.step_type === "tool" && step.state === "DONE" && !this.shownTools.has(step.step_index)) {
        this.shownTools.add(step.step_index);
        this.emit(`${this.text && !this.text.endsWith("\n") ? "\n" : ""}${progressLine(step)}\n`, chunks);
      }
    } else if (event?.event === "result" && event.result) {
      this.result = event.result;
      this.conversationId = event.result.conversation_id || this.conversationId;
    }
    return chunks;
  }

  /** Close the turn from the terminal result. Throws a named error unless the status is SUCCESS. */
  finish(result = this.result) {
    if (!result) throw new AgyError("agy ended without a result event", CODES.FAILED);
    if (result.status !== "SUCCESS") throw errorForResult(result, this.model);
    const chunks = [];
    if (!this.started) {
      const response = typeof result.response === "string" ? result.response : "";
      this.emit(response || "(agy finished without a text reply)", chunks);
    }
    chunks.push({ type: "block-end", index: 0, block: { type: "text", text: this.text } });
    chunks.push({ type: "usage", usage: mapUsage(result.usage) });
    const conversationId = result.conversation_id || this.conversationId;
    chunks.push({
      type: "finish",
      reason: { kind: "stop" },
      replayState: { agy: { version: 1, ...(conversationId ? { conversationId } : {}) } },
    });
    return chunks;
  }
}
