/**
 * Protocol facts used by the ACP route: the server's real session options (model and thinking level), the real
 * context window from `usage_update`, cumulative-usage normalisation, and named errors. The option values are read
 * from the server; none of the levels or windows is guessed here.
 */
import { AgyError, CODES, SIGN_IN_HINT, cleanAgyText } from "../errors.js";

const EFFORT_NAMES = new Map([
  ["low", "low"], ["medium", "medium"], ["high", "high"],
  ["extra", "xhigh"], ["xhigh", "xhigh"], ["max", "max"],
]);
const AUTH = /authentication required|not signed in|unauthenticated|sign[ -]?in|credential/i;
const BAD_MODEL = /not recognized as a known model|invalid model selection|unknown model|not available (?:on|for|in) your|does not have access|not entitled|model not found/i;
const WINDOW = /context.*(?:length|window|limit|overflow|exceeded)|too long|token limit|prompt is too long/i;

const positive = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : undefined);

/** Normalise an effort id/value (Google calls xhigh "Extra") to the harness's id. */
export const canonicalEffort = (value) => {
  const key = String(value ?? "").toLowerCase();
  return EFFORT_NAMES.get(key) ?? (["low", "medium", "high", "xhigh", "max"].includes(key) ? key : undefined);
};

/** The agent's option list -> the models and effort levels it really offers, plus the id to set each one. */
export function parseSessionOptions(options) {
  const all = Array.isArray(options) ? options.filter((option) => option && typeof option.id === "string") : [];
  const selectable = (option) => Array.isArray(option?.options) && option.options.some((entry) => typeof entry?.value === "string");
  const modelOption = all.find((option) => selectable(option) && /^model$/i.test(option.id))
    ?? all.find((option) => selectable(option) && option.category === "model");
  const effortOption = all.find((option) => selectable(option) && /thought|reason|effort/i.test(option.id))
    ?? all.find((option) => selectable(option) && option.options.some((entry) => EFFORT_NAMES.has(String(entry.name ?? entry.value).toLowerCase())));
  const efforts = [];
  if (effortOption) {
    for (const entry of effortOption.options) {
      const label = String(entry?.name ?? entry?.value ?? "").toLowerCase();
      const id = EFFORT_NAMES.get(label) ?? EFFORT_NAMES.get(String(entry?.value ?? "").toLowerCase());
      if (id && !efforts.some((effort) => effort.id === id)) efforts.push({ id, name: label, value: entry.value });
    }
  }
  return {
    options: all,
    modelOptionId: modelOption?.id,
    models: modelOption?.options.filter((entry) => typeof entry?.value === "string").map((entry) => ({
      id: entry.value,
      name: typeof entry.name === "string" && entry.name ? entry.name : entry.value,
    })),
    effortOptionId: effortOption?.id,
    efforts,
  };
}

/** The value the server expects for a DSH effort id, or undefined when it does not offer that level. */
export function effortValue(options, effort) {
  const wanted = String(effort ?? "").toLowerCase();
  const id = wanted === "off" || wanted === "none" || wanted === "minimal" ? "low" : wanted;
  return options?.efforts?.find((entry) => entry.id === id)?.value;
}

/**
 * ACP reports cumulative input/cacheRead across a tool-call turn while `totalTokens` is the single-call occupancy.
 * Scaling the prompt buckets to the total keeps the harness's overflow check from compacting early. `usage_update`
 * also carries the real context-window `size`, which is returned separately for the model catalog.
 */
export function normalizeUsage({ size, used, inputTokens, cacheReadTokens, outputTokens, totalTokens } = {}) {
  const contextWindow = positive(size);
  let input = Math.max(0, Number(inputTokens) || 0);
  let cacheRead = Math.max(0, Number(cacheReadTokens) || 0);
  let total = positive(totalTokens) ?? (input + cacheRead > 0 ? input + cacheRead : undefined) ?? positive(used);
  if (total === undefined) return { usage: undefined, contextWindow };
  // A bare usage_update reports only context occupancy: treat `used` as the prompt buckets for the harness.
  if (input + cacheRead === 0 && positive(used)) input = total;
  if (input + cacheRead > total) {
    const prompt = input + cacheRead;
    cacheRead = Math.floor((cacheRead / prompt) * total);
    input = total - cacheRead;
  }
  const usage = {
    inputTokens: input,
    outputTokens: Math.max(0, Number(outputTokens) || 0),
    totalTokens: total,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
  };
  return { usage, contextWindow };
}

/** Every failure names its cause: signed out, model not on the plan, context, bridge or ACP protocol. */
export function acpError(error, { model } = {}) {
  if (error instanceof AgyError) return error;
  const cause = error?.cause;
  const rpc = cause && typeof cause === "object" ? cause : error;
  const text = cleanAgyText([rpc?.message, cause?.message, String(error)].filter(Boolean).join(" ")).trim();
  if (rpc?.code === -32000 || AUTH.test(text)) {
    return new AgyError(`agy is not signed in: ${text.slice(0, 500)}; ${SIGN_IN_HINT}`, CODES.NOT_SIGNED_IN, { cause: error });
  }
  if (rpc?.code === -32800 || /cancel/i.test(text)) {
    return new AgyError(`agy ACP turn cancelled: ${text.slice(0, 500)}`, CODES.CANCELLED, { cause: error });
  }
  if (BAD_MODEL.test(text)) {
    return new AgyError(`agy: model "${model}" is not available on this plan (${text.slice(0, 500)}); run \`steak-dsh models --provider agy\` to see what the plan offers`, CODES.MODEL_UNAVAILABLE, { cause: error });
  }
  if (WINDOW.test(text)) {
    return new AgyError(`agy context window exceeded: ${text.slice(0, 500)}`, "CONTEXT_WINDOW_EXCEEDED", { cause: error });
  }
  return new AgyError(`agy ACP protocol error: ${text.slice(0, 500) || "no response"}`, CODES.ACP_PROTOCOL ?? "AGY_ACP_PROTOCOL", { cause: error });
}
