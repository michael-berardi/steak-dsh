/** Named failure classes of the agy route. The codes are outside the harness's default retry set. */
export const CODES = Object.freeze({
  MISSING: "AGY_MISSING",
  NOT_SIGNED_IN: "AGY_NOT_SIGNED_IN",
  MODEL_UNAVAILABLE: "AGY_MODEL_UNAVAILABLE",
  TIMEOUT: "AGY_TIMEOUT",
  CANCELLED: "AGY_CANCELLED",
  INVALID: "AGY_INVALID",
  BAD_REQUEST: "AGY_BAD_REQUEST",
  ACP_PROTOCOL: "AGY_ACP_PROTOCOL",
  ACP_BRIDGE: "AGY_ACP_BRIDGE",
  ACP_UNSUPPORTED: "AGY_ACP_UNSUPPORTED",
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

/** Text from agy that is safe to show: URLs (a sign-in link is a credential) and control characters removed. */
export function cleanAgyText(text) {
  return String(text ?? "")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, "[link removed]")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[ \t]{2,}/g, " ");
}
