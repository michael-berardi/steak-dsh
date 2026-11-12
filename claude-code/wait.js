import { ClaudeCodeError, CODES } from "./errors.js";

/** A terminal local wait failure, not a suggestion to replay a charged turn. */
export class ClaudeWaitLimitError extends ClaudeCodeError {
  constructor(message) {
    super(message, CODES.WAIT_LIMIT);
    this.name = "ClaudeWaitLimitError";
  }
}

/** A transport deadline must be finite: zero/Infinity must never disable it. */
export function transportTimeout(value, fallback = 180_000) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error("Claude Code timeout must be a positive finite number of milliseconds (at most 2147483647)");
  }
  return value;
}

/** Stop waiting even if a child/pipe never emits its expected terminal event. */
export function waitForOperation(
  operation,
  timeoutMs,
  label,
  signal,
  onStop,
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value, stopped = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (stopped) {
        try { onStop?.(); }
        catch (cause) {
          reject(new Error(`${label} cleanup failed after ${String(error)}`, { cause }));
          return;
        }
      }
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const abort = () => finish(signal?.reason ?? new Error("Claude Code request aborted"), undefined, true);
    const timer = setTimeout(() => finish(new ClaudeWaitLimitError(`${label} exceeded its wait limit`), undefined, true), timeoutMs);
    operation.then((value) => finish(undefined, value), (error) => finish(error));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
