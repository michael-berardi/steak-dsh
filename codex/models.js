/**
 * The account's model list, asked from the Codex backend at runtime. Nothing here names a model: ids, names,
 * context size, effort levels and input kinds all come from what the backend reports for the logged-in account.
 */
import { CODES, CodexError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
/**
 * The backend hides a model from clients older than the version that model needs, and the request must carry a
 * version. This route does not drive the Codex client, so by default it asks as the newest client and gets every
 * model the account offers. Set STEAK_DSH_CODEX_CLIENT_VERSION to ask as a specific version.
 */
const NEWEST_CLIENT = "999.0.0";
const LIST_TIMEOUT_MS = 20_000;
const MAX_LIST_BYTES = 16 * 1024 * 1024;
const INPUT_KINDS = new Set(["text", "image"]);

export function clientVersion(env = process.env) {
  const configured = (env.STEAK_DSH_CODEX_CLIENT_VERSION ?? "").trim();
  return /^\d+\.\d+\.\d+$/u.test(configured) ? configured : NEWEST_CLIENT;
}

/** An endpoint override must be HTTPS, or plain HTTP to this machine (tests). Anything else is refused. */
export function checkedUrl(value, what) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CodexError(`Codex route: ${what} is not a URL`, CODES.INVALID_CONFIG);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CodexError(`Codex route: ${what} must be https, or http on this machine`, CODES.INVALID_CONFIG);
  }
  return value.replace(/\/+$/u, "");
}

/** The backend's row, reduced to what the route uses. */
export function normalizeRow(row) {
  const efforts = Array.isArray(row?.supported_reasoning_levels)
    ? row.supported_reasoning_levels.map((level) => (typeof level === "string" ? level : level?.effort)).filter((level) => typeof level === "string" && level)
    : [];
  const input = Array.isArray(row?.input_modalities) ? row.input_modalities.filter((kind) => INPUT_KINDS.has(kind)) : [];
  return {
    id: typeof row?.slug === "string" ? row.slug : "",
    name: typeof row?.display_name === "string" && row.display_name ? row.display_name : undefined,
    description: typeof row?.description === "string" && row.description ? row.description : undefined,
    contextWindow: Number.isInteger(row?.context_window) && row.context_window > 0 ? row.context_window : undefined,
    efforts,
    defaultEffort: typeof row?.default_reasoning_level === "string" && row.default_reasoning_level ? row.default_reasoning_level : undefined,
    input: input.length ? input : undefined,
    // The backend marks the rows its own picker shows; a row without the field is treated as shown.
    listed: row?.visibility === undefined || row.visibility === "list",
  };
}

/** Backend rows to the rows the route offers: the ones the backend lists, without repeats. */
export function rowsFromListing(models) {
  const seen = new Set();
  const rows = [];
  for (const raw of Array.isArray(models) ? models : []) {
    const row = normalizeRow(raw);
    if (!row.id || !row.listed || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  return rows;
}

function safeDetail(text) {
  try {
    const body = JSON.parse(text);
    const detail = body?.error?.message ?? body?.detail ?? body?.error?.code ?? body?.error;
    if (typeof detail === "string" && detail) return `: ${detail.replace(/\s+/gu, " ").slice(0, 200)}`;
  } catch {
    // not JSON: say nothing more than the status
  }
  return "";
}

/**
 * Ask the backend which models the logged-in account can use.
 * @param {{access: {token: string, accountId: string}, baseUrl?: string, version?: string, fetchImpl?: typeof fetch, signal?: AbortSignal, timeoutMs?: number}} input
 * @returns {Promise<Array<ReturnType<typeof normalizeRow>>>}
 */
export async function fetchCodexModels({ access, baseUrl = DEFAULT_BASE_URL, version = NEWEST_CLIENT, fetchImpl = globalThis.fetch, signal, timeoutMs = LIST_TIMEOUT_MS }) {
  const url = `${baseUrl.replace(/\/+$/u, "")}/codex/models?client_version=${encodeURIComponent(version)}`;
  const limit = AbortSignal.timeout(timeoutMs);
  let response;
  let text;
  try {
    response = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${access.token}`,
        "chatgpt-account-id": access.accountId,
        originator: "steak-dsh",
        "user-agent": "steak-dsh",
        accept: "application/json",
      },
      signal: signal ? AbortSignal.any([signal, limit]) : limit,
    });
    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (declared > MAX_LIST_BYTES) throw new CodexError("The Codex model list is larger than this route accepts", CODES.MODELS_FAILED);
    text = await response.text();
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof CodexError) throw error;
    const why = limit.aborted ? `no answer within ${timeoutMs} ms` : (error?.cause?.code ?? error?.name ?? "request failed");
    throw new CodexError(`The Codex model list could not be fetched (${why})`, CODES.MODELS_FAILED);
  }
  if (response.status === 401 || response.status === 403) {
    throw new CodexError(`The Codex backend refused the login (HTTP ${response.status}${safeDetail(text)}). Run \`codex login\` and try again.`, CODES.NOT_LOGGED_IN);
  }
  if (!response.ok) {
    throw new CodexError(`The Codex model list request failed (HTTP ${response.status}${safeDetail(text)})`, CODES.MODELS_FAILED);
  }
  if (text.length > MAX_LIST_BYTES) throw new CodexError("The Codex model list is larger than this route accepts", CODES.MODELS_FAILED);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new CodexError("The Codex model list was not JSON", CODES.MODELS_FAILED);
  }
  if (!Array.isArray(body?.models)) throw new CodexError("The Codex model list has no models array", CODES.MODELS_FAILED);
  return rowsFromListing(body.models);
}
