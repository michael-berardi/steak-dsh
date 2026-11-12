/**
 * Guards against requests silently moving from Claude plan limits to
 * pay-as-you-go usage credits (formerly "extra usage").
 */

import { envFlagEnabled } from "./env.js";
import { ClaudeCodeError, CODES } from "./errors.js";

export const ALLOW_USAGE_CREDITS_ENV = "STEAK_DSH_CLAUDE_CODE_ALLOW_USAGE_CREDITS";

// Claude Code's `rate_limit_event.rate_limit_info` carries `status`, `rateLimitType`, `resetsAt` and
// `isUsingOverage`: the last one is true when the turn was charged to usage credits.

// Anthropic rejects or reroutes requests it classifies as third-party app usage with these messages. Every
// error produced here carries the code CLAUDE_CODE_BILLING, which is outside the harness's retry set.
const USAGE_CREDITS_REJECTION =
  /third-party apps now draw from your extra usage|out of extra usage|draws? from your usage credits/iu;

export function usageCreditsAllowed(env) {
  return envFlagEnabled(env[ALLOW_USAGE_CREDITS_ENV]);
}

export function usageCreditsChargeError(info) {
  return new ClaudeCodeError(
    "Claude Code billing: this request was charged to Claude usage credits instead of your plan limits " +
      `(rate limit status ${info.status ?? "unknown"}${info.rateLimitType ? `, ${info.rateLimitType}` : ""}). ` +
      "The harness stopped so further requests are not charged. To stay on plan limits only, turn off usage credits at " +
      `claude.ai/settings/usage. To allow usage credits, set ${ALLOW_USAGE_CREDITS_ENV}=1.`,
    CODES.BILLING,
  );
}

/** Rewrite an Anthropic usage-credit rejection into an actionable, non-retryable error. */
export function describeUsageCreditsRejection(message) {
  if (!USAGE_CREDITS_REJECTION.test(message)) return undefined;
  return (
    "Claude Code billing: Anthropic did not accept this request on your Claude plan limits and wants to charge " +
    "it to usage credits. This happens when your plan limit is used up, or when Anthropic classifies the " +
    "request as third-party app usage. It will not be retried. Original error: " +
    message
  );
}
