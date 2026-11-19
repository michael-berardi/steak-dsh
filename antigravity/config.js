/**
 * Operator configuration for the Antigravity route: `$DSH_HOME/steak-dsh-antigravity.json` (default
 * `~/.dsh/steak-dsh-antigravity.json`, override with STEAK_DSH_ANTIGRAVITY_CONFIG). Imports node built-ins only, so
 * reading it when the route is off costs one failed file read and loads nothing else.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AntigravityError, CODES } from "./errors.js";

export const CONFIG_ENV = "STEAK_DSH_ANTIGRAVITY_CONFIG";
export const PROVIDER_ID = "antigravity";
export const DEFAULT_BASE_URLS = ["https://cloudcode-pa.googleapis.com"];
const DEFAULT_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/aicode",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

export function dshHome(env = process.env) {
  return (env.DSH_HOME ?? "").trim() || join(homedir(), ".dsh");
}

export function configPath(env = process.env) {
  return (env[CONFIG_ENV] ?? "").trim() || join(dshHome(env), "steak-dsh-antigravity.json");
}

/** Where `steak-dsh antigravity login` keeps the sign-in (mode 0600). */
export function credentialPath(env = process.env) {
  return join(dshHome(env), "steak-dsh-antigravity-auth.json");
}

const bad = (message) => new AntigravityError(`Antigravity config: ${message}`, CODES.NOT_CONFIGURED);
const isLoopback = (host) => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);

/** An endpoint must be https, or plain http only to this machine (a local test server). No credentials in the URL. */
export function checkUrl(name, value) {
  if (typeof value !== "string" || !value) throw bad(`"${name}" must be a URL string`);
  let url;
  try { url = new URL(value); } catch { throw bad(`"${name}" is not a valid URL`); }
  if (url.username || url.password) throw bad(`"${name}" must not contain credentials`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) throw bad(`"${name}" must be https (http is allowed only for localhost)`);
  return value.replace(/\/+$/u, "");
}

function whole(name, value, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > max) throw bad(`"${name}" must be a whole number from 0 to ${max}`);
  return value;
}

function optionalString(name, value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw bad(`"${name}" must be a non-empty string`);
  return value.trim();
}

/** Validate a parsed config object. Returns undefined when the route is not turned on. */
export function parseConfig(raw, version = "dev") {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw bad("the file must be a JSON object");
  if (raw.enabled !== true) return undefined;
  const urls = raw.baseUrls === undefined ? DEFAULT_BASE_URLS : raw.baseUrls;
  if (!Array.isArray(urls) || urls.length === 0) throw bad('"baseUrls" must be a non-empty array of URLs');
  const scopes = raw.scopes === undefined ? DEFAULT_SCOPES : raw.scopes;
  if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === "string" && s)) throw bad('"scopes" must be an array of strings');
  const port = whole("redirectPort", raw.redirectPort, 51121, 65535);
  if (port < 1024) throw bad('"redirectPort" must be from 1024 to 65535');
  return {
    enabled: true,
    clientId: optionalString("clientId", raw.clientId),
    clientSecret: optionalString("clientSecret", raw.clientSecret),
    baseUrls: urls.map((u, i) => checkUrl(`baseUrls[${i}]`, u)),
    authUrl: checkUrl("authUrl", raw.authUrl ?? DEFAULT_AUTH_URL),
    tokenUrl: checkUrl("tokenUrl", raw.tokenUrl ?? DEFAULT_TOKEN_URL),
    scopes,
    redirectPort: port,
    userAgent: optionalString("userAgent", raw.userAgent) ?? `steak-dsh-antigravity/${version}`,
    requestType: optionalString("requestType", raw.requestType) ?? "agent",
    ideType: optionalString("ideType", raw.ideType) ?? "ANTIGRAVITY",
    projectId: optionalString("projectId", raw.projectId),
    maxRateLimitWaitMs: whole("maxRateLimitWaitMs", raw.maxRateLimitWaitMs, 30_000, 300_000),
    maxRateLimitRetries: whole("maxRateLimitRetries", raw.maxRateLimitRetries, 2, 3),
  };
}

/**
 * Read the operator's config. Undefined when there is no file or it does not say `"enabled": true`: the route then
 * registers nothing. A file that exists but is unreadable, not JSON or invalid is a named error, because a typo must
 * not silently leave the route off. A file that other users can write, or that another user owns, is refused; so is one holding a client secret that they can read.
 */
export function loadConfig(env = process.env, version) {
  const path = configPath(env);
  let text;
  try { text = readFileSync(path, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new AntigravityError(`Cannot read ${path}: ${error.message}`, CODES.NOT_CONFIGURED, { cause: error });
  }
  let raw;
  try { raw = JSON.parse(text); } catch { throw new AntigravityError(`${path} is not valid JSON`, CODES.NOT_CONFIGURED); }
  const config = parseConfig(raw, typeof version === "function" ? version() ?? "dev" : version);
  if (config && process.platform !== "win32") {
    // The endpoints in this file decide where the token is sent, so whoever can write it can take the token.
    const info = statSync(path);
    const mode = info.mode & 0o777;
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new AntigravityError(`${path} is not owned by the current user (owner uid ${info.uid}); run: chown "$(id -un)" ${path} && chmod 600 ${path}`, CODES.NOT_CONFIGURED);
    }
    if (mode & 0o022) throw new AntigravityError(`${path} is writable by other users (mode ${mode.toString(8)}), and its endpoints decide where the token is sent; run: chmod 600 ${path}`, CODES.NOT_CONFIGURED);
    if (config.clientSecret && mode & 0o077) throw new AntigravityError(`${path} holds a client secret but is readable by other users (mode ${mode.toString(8)}); run: chmod 600 ${path}`, CODES.NOT_CONFIGURED);
  }
  return config;
}
