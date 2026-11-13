/**
 * The Codex CLI's own ChatGPT login, read where the CLI keeps it (`$CODEX_HOME/auth.json`, default `~/.codex`).
 *
 * The file is read at the moment a request or a model list needs a token and at no other time. Nothing here prints,
 * logs or returns a token in a message. An access token past its expiry is renewed with the login's refresh token
 * (the same OAuth refresh request the CLI makes) and the renewed login is written back to the same file in the CLI's
 * format, because the refresh token rotates: a renewal that was not saved would log the CLI out.
 *
 * A login in API-key mode is refused: this route runs on the ChatGPT plan only.
 */
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODES, CodexError } from "./errors.js";

export const TOKEN_URL = "https://auth.openai.com/oauth/token";
/** The Codex CLI's public OAuth client id: a refresh token is bound to the client that obtained it. */
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ACCOUNT_CLAIM = "https://api.openai.com/auth";
/** Renew this long before the expiry, so a token never runs out in the middle of a request. */
const EXPIRY_MARGIN_MS = 60_000;
const REFRESH_TIMEOUT_MS = 30_000;
const LOGIN_HINT = "Run `codex login` (the official Codex CLI) and try again.";

/** The folder the Codex CLI keeps its login in. */
export function codexHome(env = process.env) {
  const configured = (env.STEAK_DSH_CODEX_HOME ?? "").trim() || (env.CODEX_HOME ?? "").trim();
  return configured || join(homedir(), ".codex");
}

export function authFile(env = process.env) {
  return join(codexHome(env), "auth.json");
}

/** The claims of a JWT, or undefined when the value is not one. Never throws; never echoes the value. */
export function tokenClaims(token) {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? claims : undefined;
  } catch {
    return undefined;
  }
}

async function readDocument(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new CodexError(
        `No Codex login found (${file} does not exist). ${LOGIN_HINT} A login kept in the OS keyring cannot be read: set cli_auth_credentials_store = "file" in the Codex config.`,
        CODES.NOT_LOGGED_IN,
      );
    }
    throw new CodexError(`The Codex login could not be read (${error?.code ?? "read failed"}: ${file}).`, CODES.NOT_LOGGED_IN);
  }
  try {
    const document = JSON.parse(text);
    if (document && typeof document === "object" && !Array.isArray(document)) return document;
  } catch {
    // reported below
  }
  throw new CodexError(`The Codex login file is not a JSON object (${file}). ${LOGIN_HINT}`, CODES.NOT_LOGGED_IN);
}

/** The login as the route uses it. `expiresAt` is undefined when the token carries no expiry. */
function loginFrom(document, file) {
  const tokens = document.tokens;
  const access = tokens && typeof tokens === "object" ? tokens.access_token : undefined;
  if (typeof access !== "string" || !access) {
    const apiKeyMode = typeof document.OPENAI_API_KEY === "string" && document.OPENAI_API_KEY.length > 0;
    throw new CodexError(
      apiKeyMode
        ? `The Codex CLI is set up with an API key (${file}). This route runs on a ChatGPT login only and never uses an API key. ${LOGIN_HINT}`
        : `The Codex login holds no access token (${file}). ${LOGIN_HINT}`,
      CODES.NOT_LOGGED_IN,
    );
  }
  const claims = tokenClaims(access);
  const accountId = claims?.[ACCOUNT_CLAIM]?.chatgpt_account_id ?? tokens.account_id;
  if (typeof accountId !== "string" || !accountId) {
    throw new CodexError(`The Codex login names no ChatGPT account (${file}). ${LOGIN_HINT}`, CODES.NOT_LOGGED_IN);
  }
  return {
    token: access,
    accountId,
    refreshToken: typeof tokens.refresh_token === "string" && tokens.refresh_token ? tokens.refresh_token : undefined,
    expiresAt: Number.isFinite(claims?.exp) ? claims.exp * 1000 : undefined,
  };
}

/** Read the login without renewing it. Throws CODEX_NOT_LOGGED_IN when there is none. */
export async function readLogin(env = process.env) {
  const file = authFile(env);
  return loginFrom(await readDocument(file), file);
}

const fresh = (login, now) => login.expiresAt === undefined || login.expiresAt - now > EXPIRY_MARGIN_MS;

/** A short, safe reason from a refused refresh: the status and the server's error code, never the body. */
async function refusal(response) {
  let code = "";
  try {
    const body = await response.json();
    const raw = typeof body?.error === "string" ? body.error : body?.error?.code;
    if (typeof raw === "string" && /^[a-z_]{1,60}$/u.test(raw)) code = ` ${raw}`;
  } catch {
    // no readable reason
  }
  return `HTTP ${response.status}${code}`;
}

/** Save a renewed login in the CLI's own format, unless something else renewed it in the meantime. */
async function saveRenewed(file, usedRefreshToken, renewed, now) {
  const current = await readDocument(file);
  if (current.tokens?.refresh_token !== usedRefreshToken) return false;
  const next = {
    ...current,
    tokens: {
      ...current.tokens,
      access_token: renewed.access_token,
      ...(typeof renewed.refresh_token === "string" && renewed.refresh_token ? { refresh_token: renewed.refresh_token } : {}),
      ...(typeof renewed.id_token === "string" && renewed.id_token ? { id_token: renewed.id_token } : {}),
    },
    last_refresh: new Date(now).toISOString(),
  };
  const temp = `${file}.steak-dsh-${process.pid}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return true;
}

const renewals = new Map(); // auth file -> the renewal in flight, so concurrent requests share one

async function renew(file, login, { fetchImpl, tokenUrl, now, report }) {
  if (!login.refreshToken) {
    throw new CodexError(`The Codex login has expired and holds no refresh token. ${LOGIN_HINT}`, CODES.TOKEN_EXPIRED);
  }
  let response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: login.refreshToken }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS), // shared by every waiting request, so no caller's abort applies
    });
  } catch (error) {
    throw new CodexError(
      `The Codex login has expired and the login server could not be reached (${error?.cause?.code ?? error?.name ?? "request failed"}). Try again, or run \`codex login\`.`,
      CODES.TOKEN_EXPIRED,
    );
  }
  if (!response.ok) {
    // Another process (the CLI itself) may have renewed the login a moment ago: its token is as good as ours.
    const reason = await refusal(response);
    const reread = await readLogin({ STEAK_DSH_CODEX_HOME: join(file, "..") }).catch(() => undefined);
    if (reread && reread.token !== login.token && fresh(reread, now())) return reread;
    throw new CodexError(`The Codex login has expired and could not be renewed (${reason}). ${LOGIN_HINT}`, CODES.TOKEN_EXPIRED);
  }
  let renewed;
  try {
    renewed = await response.json();
  } catch {
    renewed = undefined;
  }
  if (typeof renewed?.access_token !== "string" || !renewed.access_token) {
    throw new CodexError(`The Codex login has expired and the renewal returned no access token. ${LOGIN_HINT}`, CODES.TOKEN_EXPIRED);
  }
  try {
    await saveRenewed(file, login.refreshToken, renewed, now());
  } catch (error) {
    report?.(`codex: the login was renewed but could not be saved (${error?.code ?? error?.message ?? "write failed"}); run \`codex login\` if the Codex CLI asks for it`);
  }
  const document = { tokens: { access_token: renewed.access_token, refresh_token: renewed.refresh_token ?? login.refreshToken, account_id: login.accountId } };
  return loginFrom(document, file);
}

/**
 * The access token and account id for one request, renewed first when the token is at its expiry.
 * @param {{env?: Record<string, string|undefined>, fetchImpl?: typeof fetch, tokenUrl?: string, now?: () => number, report?: (message: string) => void}} [options]
 * @returns {Promise<{token: string, accountId: string}>}
 * @throws CodexError CODEX_NOT_LOGGED_IN or CODEX_TOKEN_EXPIRED
 */
export async function codexAccess({ env = process.env, fetchImpl = globalThis.fetch, tokenUrl = TOKEN_URL, now = Date.now, report } = {}) {
  const file = authFile(env);
  let login = loginFrom(await readDocument(file), file);
  if (!fresh(login, now())) {
    let pending = renewals.get(file);
    if (!pending) {
      pending = renew(file, login, { fetchImpl, tokenUrl, now, report }).finally(() => renewals.delete(file));
      renewals.set(file, pending);
    }
    login = await pending;
  }
  return { token: login.token, accountId: login.accountId };
}
