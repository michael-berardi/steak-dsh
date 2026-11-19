/**
 * How long a Claude Code turn may be silent before it counts as dead, and how many times a dead turn is recovered.
 *
 * Measured 2026-11-18 on the same transport in Steak Pi: three turns on a 230k to 450k token context each sat with no
 * byte from the API for exactly the 300 s budget (301 s, 301 s, 302 s) and then ended with "stream idle limit exceeded",
 * with no content block ever started. One budget for every stage was too short for a big, high-effort request and too long
 * for a connection that never answers, and the failure ended the turn instead of re-asking.
 *
 * The limits are provider-neutral. They depend only on the budget the caller supplied, the size of the request and
 * the reasoning effort it asks for. All of them can be set from the environment (see the STEAK_DSH_CLAUDE_CODE_* names).
 */

/** Largest timer Node accepts: a longer delay fires after 1 ms, which would read as an instant stall. */
export const MAX_TIMER_MS = 2_147_483_647;
/** Smallest limit the environment or plugin config may set: anything shorter cuts a healthy turn, and 0 would end it at once. */
export const MIN_LIMIT_MS = 1_000;
/**
 * The most times one request is ever sent to the API, across both retry layers: the relay's quiet retry before the
 * first byte and the route's recovery with a fresh process draw from this one budget, so the worst case is 3 sends
 * (not 3 relay attempts x 3 processes = 9). It cannot be raised from the environment.
 */
export const MAX_REQUEST_SENDS = 3;

const EFFORT_RANK = { low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };

/** Effort on a 0 (none stated) to 4 scale. */
export function effortRank(shape) {
  const named = shape.effort ? EFFORT_RANK[shape.effort.toLowerCase()] : undefined;
  if (named !== undefined) return named;
  const budget = shape.thinkingBudgetTokens;
  if (typeof budget === "number" && budget > 0) return budget >= 32_000 ? 4 : budget >= 16_000 ? 3 : budget >= 4_000 ? 2 : 1;
  return 0;
}

/** Read the size and effort out of a request body without trusting its shape. */
export function requestShape(body) {
  if (!body) return {};
  const shape = { bodyBytes: body.length };
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (typeof parsed.output_config?.effort === "string") shape.effort = parsed.output_config.effort;
    if (typeof parsed.thinking?.budget_tokens === "number") shape.thinkingBudgetTokens = parsed.thinking.budget_tokens;
  } catch { /* an unreadable body only loses the effort scaling */ }
  return shape;
}

/** A limit in milliseconds, checked after rounding: at least MIN_LIMIT_MS and at most MAX_TIMER_MS, or a named error. */
export function checkedMs(name, raw) {
  const value = Math.round(Number(raw));
  if (!Number.isFinite(value) || value < MIN_LIMIT_MS || value > MAX_TIMER_MS) {
    throw new Error(`${name} must be a number of milliseconds from ${MIN_LIMIT_MS} to ${MAX_TIMER_MS} (got ${JSON.stringify(raw)})`);
  }
  return value;
}

/** A recovery count: a whole number from 0 to MAX_REQUEST_SENDS - 1 (a request is sent at most MAX_REQUEST_SENDS times in all). */
export function checkedCount(name, raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_REQUEST_SENDS - 1) {
    throw new Error(`${name} must be a whole number from 0 to ${MAX_REQUEST_SENDS - 1} (a request is sent at most ${MAX_REQUEST_SENDS} times in all)`);
  }
  return value;
}

function envMs(env, name) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return undefined;
  return checkedMs(name, raw);
}

function envCount(env, name) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return undefined;
  return checkedCount(name, raw);
}

/**
 * The limits for one request.
 *
 * `timeoutMs` is the caller's idle budget (the caller supplies it; the route defaults to 180 000). Without overrides:
 *  - stream idle = 1.4 x budget, +0.1 per effort step, +0.1 for a very large context, capped at 1.8 x budget
 *    (252 s to 324 s at the default 180 s budget), so a quiet but alive turn is not cut at the old limit;
 *  - first byte = 0.3 x budget, widened by effort (+15% a step) and context (up to +50%): 54 s to about 115 s at the
 *    default budget, short because the API answers a healthy request at once. A resend is not free (it can bill the
 *    request again), so every resend, at either layer, comes out of one budget of MAX_REQUEST_SENDS (3) sends.
 * Environment overrides are absolute and are not scaled:
 *  STEAK_DSH_CLAUDE_CODE_IDLE_LIMIT_MS, STEAK_DSH_CLAUDE_CODE_FIRST_BYTE_LIMIT_MS, STEAK_DSH_CLAUDE_CODE_MAX_RECOVERIES (0 to 2; 0 turns recovery off).
 * A limit is rounded first, then must be at least MIN_LIMIT_MS and at most MAX_TIMER_MS, or the call throws with the name.
 */
export function idleLimits(timeoutMs, shape = {}, env = process.env) {
  const contextTokens = (shape.bodyBytes ?? 0) / 3.5;
  const contextWeight = Math.min(1, contextTokens / 400_000);
  const rank = effortRank(shape);
  const scaledIdle = timeoutMs * Math.min(1.8, 1.4 + 0.1 * rank + 0.1 * contextWeight);
  const scaledFirst = timeoutMs * 0.3 * (1 + 0.15 * rank) * (1 + 0.5 * Math.min(1, contextTokens / 500_000));
  const streamIdleMs = Math.min(MAX_TIMER_MS, Math.round(envMs(env, "STEAK_DSH_CLAUDE_CODE_IDLE_LIMIT_MS") ?? scaledIdle));
  // A first byte never gets more patience than the rest of the stream.
  const firstByteMs = Math.round(envMs(env, "STEAK_DSH_CLAUDE_CODE_FIRST_BYTE_LIMIT_MS") ?? Math.min(scaledFirst, streamIdleMs));
  const margin = Math.max(50, Math.min(15_000, Math.round(timeoutMs * 0.05)));
  return {
    firstByteMs,
    streamIdleMs,
    queueIdleMs: Math.min(MAX_TIMER_MS, Math.max(firstByteMs, streamIdleMs) + margin),
    maxRecoveries: envCount(env, "STEAK_DSH_CLAUDE_CODE_MAX_RECOVERIES") ?? MAX_REQUEST_SENDS - 1,
    maxSends: MAX_REQUEST_SENDS,
    recoveryBackoffMs: [Math.min(2_000, Math.round(timeoutMs / 10)), Math.min(8_000, Math.round(timeoutMs / 4))],
  };
}

/** "5 min 1 s", "42 s": minutes and seconds, never a bare three-digit number. */
export function formatSilence(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
