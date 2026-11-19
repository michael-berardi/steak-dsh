/**
 * The Antigravity sign-in: PKCE authorization code through a loopback callback (or a pasted callback URL), kept in
 * `$DSH_HOME/steak-dsh-antigravity-auth.json` with mode 0600, written atomically. The file is read when a request or a
 * model list needs a token; a token past its expiry is renewed with the refresh token and the renewed sign-in is saved.
 * Nothing here prints, logs or returns a token inside a message.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { discoverProject, exchangeCode, needClient, refreshTokens } from "./client.js";
import { credentialPath } from "./config.js";
import { AntigravityError, CODES } from "./errors.js";

export const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const CALLBACK_PATH = "/oauth-callback";
const LOGIN_HINT = "Run `steak-dsh antigravity login`.";
const b64url = (buffer) => buffer.toString("base64url");

export function readCredential(env = process.env) {
  const file = credentialPath(env);
  let text;
  try { text = readFileSync(file, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") throw new AntigravityError(`No Antigravity sign-in (${file} does not exist). ${LOGIN_HINT}`, CODES.AUTH_EXPIRED);
    throw new AntigravityError(`The Antigravity sign-in could not be read (${error?.code ?? "read failed"}: ${file}). ${LOGIN_HINT}`, CODES.AUTH_EXPIRED);
  }
  try {
    const value = JSON.parse(text);
    if (value && typeof value.access === "string" && typeof value.refresh === "string" && typeof value.projectId === "string" && typeof value.expires === "number") return value;
  } catch { /* named below, without the text */ }
  throw new AntigravityError(`The Antigravity sign-in file is unreadable (${file}). ${LOGIN_HINT}`, CODES.AUTH_EXPIRED);
}

export function writeCredential(credential, env = process.env) {
  const file = credentialPath(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(credential)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

export function removeCredential(env = process.env) {
  rmSync(credentialPath(env), { force: true });
}

let renewing;

/** A session for requests: the saved sign-in, renewed first when it is at its expiry. */
export async function access({ config, env = process.env, now = Date.now, signal } = {}) {
  let credential = readCredential(env);
  if (credential.expires <= now()) {
    renewing ??= (async () => {
      const tokens = await refreshTokens(config, credential.refresh, signal);
      const next = { ...credential, access: tokens.access, refresh: tokens.refresh ?? credential.refresh, expires: tokens.expires };
      writeCredential(next, env);
      return next;
    })().finally(() => { renewing = undefined; });
    credential = await renewing;
  }
  const projectId = credential.projectId || config.projectId;
  const session = {
    token: credential.access,
    projectId,
    refresh: credential.refresh,
    // A 401 mid-request renews once; keep the renewed token for the next request too.
    onRefresh: (tokens) => writeCredential({ ...credential, access: tokens.access, refresh: tokens.refresh ?? credential.refresh, expires: tokens.expires }, env),
  };
  return session;
}

function listen(config, expectedState) {
  return new Promise((resolve, reject) => {
    let settle;
    const wait = new Promise((ok, fail) => { settle = { ok, fail }; });
    wait.catch(() => {});
    const page = (res, status, text) => {
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(text);
    };
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "", "http://127.0.0.1");
      if (req.method !== "GET" || url.pathname !== CALLBACK_PATH) return page(res, 404, "Not found");
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (error) { page(res, 400, "Sign-in failed. You can close this window."); settle.fail(new AntigravityError(`Google sign-in was refused: ${error.slice(0, 100)}`, CODES.SIGN_IN)); return; }
      if (!code || !state) { page(res, 400, "Sign-in failed: missing code or state."); settle.fail(new AntigravityError("The sign-in callback had no code or state", CODES.SIGN_IN)); return; }
      if (state !== expectedState) { page(res, 400, "Sign-in failed: state mismatch."); settle.fail(new AntigravityError("The sign-in callback state did not match this sign-in (possible forged callback); start the login again", CODES.SIGN_IN)); return; }
      page(res, 200, "Antigravity sign-in complete. You can close this window and return to the terminal.");
      settle.ok({ code, state });
    });
    server.once("error", (error) => reject(error.code === "EADDRINUSE"
      ? new AntigravityError(`Port ${config.redirectPort} is already in use; free it or set "redirectPort" (it must match the OAuth client's registered redirect)`, CODES.SIGN_IN)
      : error));
    server.listen(config.redirectPort, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : config.redirectPort;
      const timer = setTimeout(() => settle.fail(new AntigravityError("Timed out waiting for the browser sign-in (5 minutes)", CODES.SIGN_IN)), CALLBACK_TIMEOUT_MS);
      timer.unref?.();
      resolve({ wait, redirectUri: `http://localhost:${port}${CALLBACK_PATH}`, close() { clearTimeout(timer); server.closeAllConnections?.(); server.close(); } });
    });
  });
}

/** A callback URL (or bare query string) pasted from a browser that could not reach this machine. */
export function parsePasted(raw, expectedState) {
  const text = String(raw ?? "").trim();
  if (!text) throw new AntigravityError("Nothing was pasted; paste the full callback URL from the browser's address bar", CODES.SIGN_IN);
  let url;
  try { url = new URL(text); } catch { url = new URL(`http://localhost${CALLBACK_PATH}?${text.replace(/^\?/, "")}`); }
  const error = url.searchParams.get("error");
  if (error) throw new AntigravityError(`Google sign-in was refused: ${error.slice(0, 100)}`, CODES.SIGN_IN);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new AntigravityError("The pasted text has no code or state; paste the full callback URL", CODES.SIGN_IN);
  if (state !== expectedState) throw new AntigravityError("The pasted callback belongs to a different sign-in; run the login again and paste the new URL", CODES.SIGN_IN);
  return { code, state };
}

/**
 * Sign in. `io.notify(url, instructions)` shows the sign-in address; `io.prompt(message, signal)` asks for a pasted
 * callback URL and rejects when `signal` aborts. The saved credential is returned without its tokens' meaning being
 * interpreted; it is written to the credential file only after the project lookup succeeded.
 */
export async function login(config, io, { env = process.env, signal } = {}) {
  const { clientId } = needClient(config);
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  // The state is independent of the verifier, so a leaked callback URL cannot disclose the verifier.
  const state = b64url(randomBytes(32));
  const listener = await listen(config, state);
  const settle = new AbortController();
  try {
    const params = new URLSearchParams({
      client_id: clientId, response_type: "code", redirect_uri: listener.redirectUri, scope: config.scopes.join(" "),
      code_challenge: challenge, code_challenge_method: "S256", state, access_type: "offline", prompt: "consent",
    });
    io.notify(`${config.authUrl}?${params.toString()}`, "Complete the Google sign-in. The callback is captured by itself; on a remote machine, paste the callback URL when asked.");
    const pasted = (async () => {
      let message = "Browser on another machine? After signing in, paste the full callback URL from its address bar.";
      for (;;) {
        const text = await io.prompt(message, settle.signal);
        try { return parsePasted(text, state); } catch (error) { message = `${error.message}. Paste the full callback URL:`; }
      }
    })();
    pasted.catch(() => {});
    const aborted = new Promise((_, reject) => {
      const onAbort = () => reject(new AntigravityError("Sign-in cancelled", CODES.SIGN_IN));
      if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => {});
    const { code } = await Promise.race([listener.wait, pasted, aborted]);
    const tokens = await exchangeCode(config, code, verifier, listener.redirectUri, signal);
    if (!tokens.refresh) throw new AntigravityError("Google returned no refresh token; run the login again and allow offline access", CODES.SIGN_IN);
    const projectId = await discoverProject(config, tokens.access, signal);
    const credential = { access: tokens.access, refresh: tokens.refresh, expires: tokens.expires, projectId };
    writeCredential(credential, env);
    return credential;
  } finally {
    settle.abort();
    listener.close();
  }
}
