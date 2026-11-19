/**
 * Calls to the provider's own endpoints, and nothing else. Endpoints, OAuth URLs and the user agent all come from the
 * operator's config. A request goes to the next configured endpoint only after a transport failure or a 5xx; a 401 is
 * refreshed once; a 429 waits at most the configured bound and is resent at most the configured number of times.
 */
import { idleLimits } from "../claude-code/idle-policy.js";
import { AntigravityError, CODES, formatWait, providerMessage, retryAfterFrom } from "./errors.js";
import { post } from "./transport.js";

const DEFAULT_TIMEOUT_MS = 300_000;

export const abortableSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason ?? new Error("aborted")); return; }
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("aborted")); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

async function postForm(config, form, what, signal) {
  let response;
  try {
    response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": config.userAgent },
      body: new URLSearchParams(form).toString(),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AntigravityError(`Antigravity ${what}: cannot reach ${new URL(config.tokenUrl).host} (${error.message})`, CODES.SIGN_IN, { cause: error });
  }
  const text = await response.text();
  if (!response.ok) throw new AntigravityError(`Antigravity ${what} failed (HTTP ${response.status}): ${providerMessage(text)}`, CODES.SIGN_IN, { status: response.status });
  try { return JSON.parse(text); } catch { throw new AntigravityError(`Antigravity ${what}: the token endpoint did not return JSON`, CODES.PROTOCOL); }
}

export function needClient(config) {
  if (!config.clientId || !config.clientSecret) {
    throw new AntigravityError('Antigravity sign-in needs an OAuth client: set "clientId" and "clientSecret" in the Antigravity config file (none is shipped with Steak DSH)', CODES.NOT_CONFIGURED);
  }
  return { clientId: config.clientId, clientSecret: config.clientSecret };
}

function tokensFrom(data, what) {
  if (typeof data.access_token !== "string" || typeof data.expires_in !== "number") {
    throw new AntigravityError(`Antigravity ${what}: the token endpoint reply has no access_token / expires_in`, CODES.PROTOCOL);
  }
  // Treat the token as expired five minutes early, so it is renewed before a request can meet a 401.
  return { access: data.access_token, refresh: typeof data.refresh_token === "string" ? data.refresh_token : undefined, expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000 };
}

export async function exchangeCode(config, code, verifier, redirectUri, signal) {
  const { clientId, clientSecret } = needClient(config);
  return tokensFrom(await postForm(config, { client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri, code_verifier: verifier }, "token exchange", signal), "token exchange");
}

export async function refreshTokens(config, refresh, signal) {
  const { clientId, clientSecret } = needClient(config);
  try {
    return tokensFrom(await postForm(config, { client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: "refresh_token" }, "token refresh", signal), "token refresh");
  } catch (error) {
    if (error instanceof AntigravityError && error.code === CODES.SIGN_IN) {
      throw new AntigravityError(`${error.message}. The saved sign-in is no longer valid: run \`steak-dsh antigravity login\` again`, CODES.AUTH_EXPIRED, { status: error.status });
    }
    throw error;
  }
}

/**
 * POST a JSON body to `path` on the configured endpoints and return the open reply for a 2xx status. Every other
 * outcome is a named AntigravityError. `session` is {token, projectId, refresh?, onRefresh?}; onRefresh(tokens) lets the
 * caller save a renewed token.
 */
export async function call(config, session, path, payload, label, { signal, timeoutMs, sleep = abortableSleep } = {}) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const limits = idleLimits(timeoutMs ?? DEFAULT_TIMEOUT_MS, { bodyBytes: body.length }, {});
  let refreshed = false;
  let rateRetries = 0;
  let endpointIndex = 0;
  for (;;) {
    signal?.throwIfAborted();
    const base = config.baseUrls[endpointIndex];
    let reply;
    try {
      reply = await post(`${base}${path}`, body, {
        headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json", "User-Agent": config.userAgent, Accept: path.includes("alt=sse") ? "text/event-stream" : "application/json" },
        signal,
        limits: { firstByteMs: limits.firstByteMs, streamIdleMs: limits.streamIdleMs },
        label,
      });
    } catch (error) {
      if (error instanceof AntigravityError || signal?.aborted) throw error;
      if (endpointIndex + 1 < config.baseUrls.length) { endpointIndex += 1; continue; }
      throw new AntigravityError(`Antigravity ${label}: cannot reach ${new URL(base).host} (${error.message})`, CODES.HTTP, { cause: error });
    }
    if (reply.status >= 200 && reply.status < 300) return reply;
    const text = await reply.text().catch(() => "");
    const message = providerMessage(text);
    if (reply.status === 401) {
      if (!refreshed && session.refresh) {
        refreshed = true;
        const tokens = await refreshTokens(config, session.refresh, signal);
        session.token = tokens.access;
        await session.onRefresh?.(tokens);
        continue;
      }
      throw new AntigravityError(`Antigravity rejected the access token (HTTP 401: ${message})${refreshed ? " even after one refresh" : ""}. Run \`steak-dsh antigravity login\` to sign in again`, CODES.AUTH_EXPIRED, { status: 401 });
    }
    if (reply.status === 429) {
      const wait = retryAfterFrom(reply.headers, text);
      const quota = /quota|Resets? in|credits/i.test(text) && !/rate.?limit|too many requests/i.test(text);
      if (wait !== undefined && wait <= config.maxRateLimitWaitMs && rateRetries < config.maxRateLimitRetries) {
        rateRetries += 1;
        await sleep(wait, signal);
        continue;
      }
      const when = wait === undefined ? "the provider gave no retry time" : `retry in ${formatWait(wait)} (after ${new Date(Date.now() + wait).toISOString()})`;
      const spent = rateRetries > 0 ? ` after ${rateRetries} bounded ${rateRetries === 1 ? "wait" : "waits"}` : "";
      throw new AntigravityError(`Antigravity ${quota ? "quota reached" : "rate limit"} (HTTP 429${spent}): ${message}; ${when}`, quota ? CODES.QUOTA : CODES.RATE_LIMITED, { status: 429, retryAfterMs: wait });
    }
    if (reply.status >= 500 && endpointIndex + 1 < config.baseUrls.length) { endpointIndex += 1; continue; }
    if (reply.status === 403) throw new AntigravityError(`Antigravity refused access (HTTP 403: ${message}). The account may need verification or may lack access to this model; check it in Google's own app, then run \`steak-dsh antigravity login\``, CODES.AUTH_EXPIRED, { status: 403 });
    if (reply.status === 404) throw new AntigravityError(`Antigravity ${label}: not found (HTTP 404: ${message}). The model may not be available to this account; list models again`, CODES.HTTP, { status: 404 });
    throw new AntigravityError(`Antigravity ${label} failed (HTTP ${reply.status}: ${message})`, CODES.HTTP, { status: reply.status });
  }
}

export async function callJson(config, session, path, payload, label, options) {
  const reply = await call(config, session, path, payload, label, options);
  const text = await reply.text();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch { /* fall through to the named error */ }
  throw new AntigravityError(`Antigravity ${label}: the reply was not a JSON object`, CODES.PROTOCOL);
}

/** The cloud project requests are billed to: the configured one, or the one the account's own profile names. */
export async function discoverProject(config, token, signal) {
  if (config.projectId) return config.projectId;
  const data = await callJson(config, { token, projectId: "" }, "/v1internal:loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY" } }, "project lookup", { signal });
  const direct = data.cloudaicompanionProject;
  const id = typeof direct === "string" ? direct : typeof direct?.id === "string" ? direct.id : undefined;
  if (!id) throw new AntigravityError('Antigravity project lookup: the account has no Cloud Code project. Set "projectId" in the Antigravity config file', CODES.SIGN_IN);
  return id;
}
