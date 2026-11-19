import { ClaudeCodeError, CODES } from "./errors.js";

/**
 * A local wait failure. `kind: "idle"` is a silent model or connection, which the route may recover by asking again (only
 * while nothing was handed over and the reply was not complete); every other kind is terminal.
 */
export class ClaudeWaitLimitError extends ClaudeCodeError {
  /** "idle": the model or connection went silent mid-turn, which a fresh attempt can fix. Anything else is a local wait. */
  kind;
  /** What the silence looked like, filled in where it is known. */
  silentMs;
  stage;
  lastEvent;
  childAlive;
  bytesReceived;
  recoveries;
  /** The API had already sent the whole reply (message_stop) when the silence hit: asking again would pay for it twice. */
  replyComplete;

  constructor(message, details = {}) {
    super(message, CODES.WAIT_LIMIT);
    this.name = "ClaudeWaitLimitError";
    this.kind = details.kind;
    this.silentMs = details.silentMs;
    this.stage = details.stage;
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
  kind,
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
    const timer = setTimeout(() => finish(new ClaudeWaitLimitError(`${label} exceeded its wait limit`, { kind, silentMs: timeoutMs, stage: label }), undefined, true), timeoutMs);
    operation.then((value) => finish(undefined, value), (error) => finish(error));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
