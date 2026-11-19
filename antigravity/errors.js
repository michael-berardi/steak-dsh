/** Named failures of the Antigravity route. Every message says what failed and what to do next; none carries a token. */
export const CODES = Object.freeze({
  NOT_CONFIGURED: "ANTIGRAVITY_NOT_CONFIGURED",
  SIGN_IN: "ANTIGRAVITY_SIGN_IN",
  AUTH_EXPIRED: "ANTIGRAVITY_AUTH_EXPIRED",
  QUOTA: "ANTIGRAVITY_QUOTA",
  RATE_LIMITED: "ANTIGRAVITY_RATE_LIMITED",
  UNSUPPORTED: "ANTIGRAVITY_UNSUPPORTED",
  IDLE: "ANTIGRAVITY_IDLE",
  UPLOAD_STALLED: "ANTIGRAVITY_UPLOAD_STALLED",
  HTTP: "ANTIGRAVITY_HTTP",
  PROTOCOL: "ANTIGRAVITY_PROTOCOL",
});

/** An error carrying one of {@link CODES}; the adapter turns it into an LlmError with the same code. */
export class AntigravityError extends Error {
  constructor(message, code, { status, retryAfterMs, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AntigravityError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const SECRET_SHAPES = [
  /ya29\.[\w-]+/g,
  /1\/\/[\w-]{20,}/g,
  /GOCSPX-[\w-]+/g,
  /Bearer\s+[\w.~+/=-]+/gi,
  /("?(?:access_token|refresh_token|client_secret|code|id_token)"?\s*[:=]\s*"?)[^"&\s,}]+/gi,
];

/** Remove anything shaped like a token from text that is about to be shown. */
export function redact(text) {
  let out = String(text);
  for (const shape of SECRET_SHAPES) out = out.replace(shape, (match, prefix) => (typeof prefix === "string" ? `${prefix}[redacted]` : "[redacted]"));
  return out;
}

/** The provider's own message from an error body, redacted and bounded. */
export function providerMessage(body) {
  let text = String(body ?? "").trim();
  try {
    const parsed = JSON.parse(text);
    const inner = typeof parsed.error === "string" ? parsed.error : typeof parsed.error?.message === "string" ? parsed.error.message : undefined;
    const description = typeof parsed.error_description === "string" ? parsed.error_description : undefined;
    text = [inner, description].filter(Boolean).join(": ") || text;
  } catch { /* not JSON: the raw text is the message */ }
  return redact(text).replace(/\s+/g, " ").slice(0, 300) || "no message";
}

/** "2 h 3 min", "45 s": a wait a person can read. */
export function formatWait(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * How long the provider says to wait: Retry-After (seconds or an HTTP date), a `retryDelay` such as "3.5s" in the
 * error details, or a "Resets in 2h3m" sentence. Undefined when it says nothing.
 */
export function retryAfterFrom(headers, body, now = Date.now()) {
  const header = headers["retry-after"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw !== undefined && String(raw).trim() !== "") {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  const delay = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(body);
  if (delay) return Math.round(Number(delay[1]) * 1000);
  const resets = /Resets? in\s+((?:\d+\s*[dhms]\s*)+)/i.exec(body);
  if (resets) {
    const unit = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };
    let ms = 0;
    for (const [, amount, u] of resets[1].matchAll(/(\d+)\s*([dhms])/gi)) ms += Number(amount) * unit[u.toLowerCase()];
    return ms;
  }
  return undefined;
}
