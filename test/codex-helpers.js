// Shared helpers for the Codex route tests: a fake login file, a fake backend (model list, Responses stream, token renewal).
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";

export const ACCOUNT = "acct-test";
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A token shaped like the real one (three parts, expiry and account in the claims). `label` makes each one distinct. */
export function fakeToken(label, { expiresInMs = 3_600_000, account = ACCOUNT } = {}) {
  return `${b64({ alg: "none" })}.${b64({ exp: Math.floor((Date.now() + expiresInMs) / 1000), "https://api.openai.com/auth": { chatgpt_account_id: account }, label })}.sig-${label}`;
}

export function scratchHome(prefix = "steak-dsh-codex-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Write a login file the way the CLI lays it out. Returns the tokens written. */
export function writeLogin(home, { access = fakeToken("access-1"), refresh = "refresh-1", extra = {} } = {}) {
  const document = { auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "id-1", access_token: access, refresh_token: refresh, account_id: ACCOUNT }, last_refresh: "2026-01-01T00:00:00.000Z", ...extra };
  writeFileSync(join(home, "auth.json"), JSON.stringify(document, null, 2), { mode: 0o600 });
  return { access, refresh };
}

export const readLoginFile = (home) => JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));

export const ROWS = [
  { slug: "row-hidden", display_name: "Hidden", visibility: "hide", context_window: 1000, supported_reasoning_levels: [{ effort: "low" }] },
  { slug: "row-a", display_name: "Row A", description: "first", visibility: "list", context_window: 111_000, default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }], input_modalities: ["text", "image"] },
  { slug: "row-b", display_name: "Row B", visibility: "list", context_window: 222_000, supported_reasoning_levels: [{ effort: "low" }, { effort: "xhigh" }] },
];

const sse = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

export function textEvents(text, usage = { input_tokens: 11, output_tokens: 7, total_tokens: 18, input_tokens_details: { cached_tokens: 5 } }) {
  return [
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] } },
    { type: "response.completed", response: { id: "resp_1", status: "completed", usage } },
  ];
}

export function toolEvents(name, args) {
  const json = JSON.stringify(args);
  return [
    { type: "response.created", response: { id: "resp_t", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: json },
    { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: json },
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: json, status: "completed" } },
    { type: "response.completed", response: { id: "resp_t", status: "completed", usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 } } },
  ];
}

function decode(buffer, encoding) {
  if (encoding === "zstd") return zlib.zstdDecompressSync(buffer).toString("utf8");
  return buffer.toString("utf8");
}

/**
 * A loopback stand-in for the backend and the login server.
 * `replies` is a queue of Responses answers (arrays of events, or `{ status, body }`); `renew` answers a token renewal.
 */
export async function fakeBackend({ rows = ROWS, replies = [], renew, listStatus = 200 } = {}) {
  const seen = { lists: [], requests: [], renewals: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const raw = Buffer.concat(chunks);
      if (req.method === "GET" && url.pathname === "/codex/models") {
        seen.lists.push({ headers: req.headers, version: url.searchParams.get("client_version") });
        res.writeHead(listStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(listStatus === 200 ? { models: rows } : { error: { message: "list refused" } }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/codex/responses") {
        const body = JSON.parse(decode(raw, req.headers["content-encoding"]));
        seen.requests.push({ headers: req.headers, body });
        const reply = replies.shift() ?? textEvents("ok");
        if (Array.isArray(reply)) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(sse(reply));
        } else {
          res.writeHead(reply.status, { "content-type": "application/json" });
          res.end(JSON.stringify(reply.body));
        }
        return;
      }
      if (req.method === "POST" && url.pathname === "/oauth/token") {
        const body = JSON.parse(raw.toString("utf8"));
        seen.renewals.push({ body });
        const answer = renew ? renew(body) : { status: 400, body: { error: "invalid_grant" } };
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { seen, baseUrl: origin, tokenUrl: `${origin}/oauth/token`, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}
