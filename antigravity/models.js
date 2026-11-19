/** The model list comes from the provider on every refresh. No model id appears in this source: a test fails if one does. */
import { callJson } from "./client.js";
import { AntigravityError, CODES } from "./errors.js";

/** Limits assumed only when the provider's entry names none. Stated in the README. */
export const ASSUMED_CONTEXT_WINDOW = 128_000;
export const ASSUMED_MAX_OUTPUT = 8_192;

const SAFE_ID = /^[a-z0-9][a-z0-9_.-]*$/i;
// Internal placeholders, editor tab/chat models and image generators are not chat models.
const NOT_CHAT = /^(?:MODEL_|chat_|tab_)|image/i;
const positive = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined);

/** One entry of the provider's list -> a row, or undefined when it is not a usable chat model. */
export function rowFromEntry(id, entry) {
  if (!SAFE_ID.test(id) || NOT_CHAT.test(id)) return undefined;
  const raw = entry && typeof entry === "object" ? entry : {};
  if (raw.disabled === true || raw.isInternal === true) return undefined;
  const name = [raw.displayName, raw.label].find((v) => typeof v === "string" && v.trim() !== "") ?? id;
  return {
    id,
    name,
    reasoning: raw.supportsThinking === true,
    contextWindow: positive(raw.maxTokens) ?? ASSUMED_CONTEXT_WINDOW,
    maxTokens: positive(raw.maxOutputTokens) ?? ASSUMED_MAX_OUTPUT,
  };
}

export async function listModels(config, session, options) {
  const data = await callJson(config, session, "/v1internal:fetchAvailableModels", { project: session.projectId }, "model list", options);
  const models = data.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) throw new AntigravityError("Antigravity model list: the reply has no `models` object", CODES.PROTOCOL);
  const rows = Object.entries(models).flatMap(([id, entry]) => { const row = rowFromEntry(id, entry); return row ? [row] : []; });
  if (rows.length === 0) throw new AntigravityError("Antigravity model list: the provider returned no usable chat models for this account", CODES.PROTOCOL);
  return rows;
}
