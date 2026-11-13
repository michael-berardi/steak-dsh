/** Named failure classes of the Codex route. The codes are outside the harness's default retry set. */
export const CODES = Object.freeze({
  NOT_LOGGED_IN: "CODEX_NOT_LOGGED_IN",
  TOKEN_EXPIRED: "CODEX_TOKEN_EXPIRED",
  MODELS_FAILED: "CODEX_MODELS_FAILED",
  HARNESS_UNSUPPORTED: "CODEX_HARNESS_UNSUPPORTED",
  INVALID_CONFIG: "CODEX_INVALID_CONFIG",
});

/** An error carrying one of {@link CODES}; the adapter turns it into an LlmError with the same code. */
export class CodexError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = "CodexError";
    this.code = code;
  }
}
