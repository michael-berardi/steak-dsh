/** Named failure classes of the Claude Code route. The codes are outside the harness's default retry set. */
export const CODES = Object.freeze({
  NOT_READY: "CLAUDE_CODE_NOT_READY",
  CONFLICTING_ENV: "CLAUDE_CODE_CONFLICTING_ENV",
  BILLING: "CLAUDE_CODE_BILLING",
  WAIT_LIMIT: "CLAUDE_CODE_WAIT_LIMIT",
  FAILED: "CLAUDE_CODE_FAILED",
  UNKNOWN_TOOL: "CLAUDE_CODE_UNKNOWN_TOOL",
});

/** An error carrying one of {@link CODES}; the adapter turns it into an LlmError with the same code. */
export class ClaudeCodeError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = "ClaudeCodeError";
    this.code = code;
  }
}
