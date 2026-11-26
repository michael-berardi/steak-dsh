/**
 * Strictly provider-neutral `<provider>/<model-id>` syntax parser shared by CLI flags, chat and TUI.
 * Validates structure only; never lists or prefers any provider or model.
 */

const DISALLOWED_CHARS = /[\s\x00-\x1f\x7f]/;

/**
 * Parse `<provider>/<model-id>` where the model id itself may contain slashes (e.g. `acme/org/model-1`),
 * while rejecting empty segments at the boundary, leading slashes in the model id, whitespace or control chars.
 * Returns `{ provider, model, spec }` or `undefined` when invalid.
 */
export function parseModelSpec(raw) {
  if (typeof raw !== "string") return undefined;
  const spec = raw.trim();
  if (!spec || DISALLOWED_CHARS.test(spec)) return undefined;
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  const provider = spec.slice(0, slash);
  const model = spec.slice(slash + 1);
  if (!provider || !model || model.startsWith("/") || model.endsWith("/")) return undefined;
  return { provider, model, spec };
}

/**
 * Derive next launcher options when switching models mid-session.
 * Keeps gateway routing fields only while staying on the same declared provider; clears them when switching providers.
 */
export function nextModelOptions(current, { provider, model }) {
  if (current.provider === provider) {
    return { ...current, provider, model };
  }
  return {
    ...current,
    provider,
    model,
    baseUrl: undefined,
    api: undefined,
    keyEnv: undefined,
    compat: undefined,
    effortWire: undefined,
    contextWindow: undefined,
  };
}
