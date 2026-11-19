/** Named failure classes of the agy route. The codes are outside the harness's default retry set. */
export const CODES = Object.freeze({
  MISSING: "AGY_MISSING",
  NOT_SIGNED_IN: "AGY_NOT_SIGNED_IN",
  MODEL_UNAVAILABLE: "AGY_MODEL_UNAVAILABLE",
  TIMEOUT: "AGY_TIMEOUT",
  CANCELLED: "AGY_CANCELLED",
  INVALID: "AGY_INVALID",
  BAD_REQUEST: "AGY_BAD_REQUEST",
  FAILED: "AGY_FAILED",
});

/** An error carrying one of {@link CODES}; the adapter turns it into an LlmError with the same code. */
export class AgyError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = "AgyError";
    this.code = code;
  }
}

export const INSTALL_COMMAND = "curl -fsSL https://antigravity.google/cli/install.sh | bash";
export const MISSING_MESSAGE = `agy (Google's Antigravity CLI) is not installed. Install it with: ${INSTALL_COMMAND}`;
export const SIGN_IN_HINT = "run agy once to sign in";
