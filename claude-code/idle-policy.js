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

function envMs(env, name) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error(`${name} must be a positive number of milliseconds (at most 2147483647)`);
  }
  return value;
}

function envCount(env, name) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 10) throw new Error(`${name} must be a whole number from 0 to 10`);
  return value;
}

/**
 * The limits for one request.
 *
 * `timeoutMs` is the caller's idle budget (the caller supplies it; the route defaults to 180 000). Without overrides:
 *  - stream idle = 1.4 x budget, +0.1 per effort step, +0.1 for a very large context, capped at 1.8 x budget
 *    (420 s to 540 s for Pi's default), so a quiet but alive turn is not cut at the old 300 s;
 *  - first byte = 0.3 x budget, widened by effort (+15% a step) and context (up to +50%): 90 s to about 190 s,
 *    short because the API answers a healthy request at once and a retry costs nothing before the first byte.
 * Environment overrides are absolute and are not scaled:
 *  STEAK_DSH_CLAUDE_CODE_IDLE_LIMIT_MS, STEAK_DSH_CLAUDE_CODE_FIRST_BYTE_LIMIT_MS, STEAK_DSH_CLAUDE_CODE_MAX_RECOVERIES (0 turns recovery off).
 */
export function idleLimits(timeoutMs, shape = {}, env = process.env) {
  const contextTokens = (shape.bodyBytes ?? 0) / 3.5;
  const contextWeight = Math.min(1, contextTokens / 400_000);
  const rank = effortRank(shape);
  const scaledIdle = timeoutMs * Math.min(1.8, 1.4 + 0.1 * rank + 0.1 * contextWeight);
  const scaledFirst = timeoutMs * 0.3 * (1 + 0.15 * rank) * (1 + 0.5 * Math.min(1, contextTokens / 500_000));
  const streamIdleMs = Math.round(envMs(env, "STEAK_DSH_CLAUDE_CODE_IDLE_LIMIT_MS") ?? scaledIdle);
  // A first byte never gets more patience than the rest of the stream.
  const firstByteMs = Math.round(envMs(env, "STEAK_DSH_CLAUDE_CODE_FIRST_BYTE_LIMIT_MS") ?? Math.min(scaledFirst, streamIdleMs));
  const margin = Math.max(50, Math.min(15_000, Math.round(timeoutMs * 0.05)));
  return {
    firstByteMs,
    streamIdleMs,
    queueIdleMs: Math.max(firstByteMs, streamIdleMs) + margin,
    statusAfterMs: Math.max(25, Math.min(30_000, Math.round(Math.min(firstByteMs, streamIdleMs) / 3))),
    maxRecoveries: envCount(env, "STEAK_DSH_CLAUDE_CODE_MAX_RECOVERIES") ?? 2,
    recoveryBackoffMs: [Math.min(2_000, Math.round(timeoutMs / 10)), Math.min(8_000, Math.round(timeoutMs / 4))],
  };
}

/** "5 min 1 s", "42 s": minutes and seconds, never a bare three-digit number. */
export function formatSilence(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
