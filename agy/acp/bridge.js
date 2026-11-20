/**
 * A per-session loopback MCP server. The agent never gets a tool executor here: every tools/call is handed to the
 * owner (the ACP session), which parks it until Steak DSH's own harness has run the tool through its approval and
 * owned-path pipeline and sent the result back. The listener is 127.0.0.1 only, on an ephemeral port, with a random
 * per-session bearer token compared in constant time. Closing the session closes the listener.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const MAX_BODY = 1_048_576;
export const MCP_SERVER_NAME = "steak-dsh-tools";

/** DSH tool definitions -> MCP tools/list rows (a fresh array; inputSchema is the harness's parameter schema). */
export function mcpTools(tools) {
  return (Array.isArray(tools) ? tools : [])
    .filter((tool) => typeof tool?.name === "string" && tool.name)
    .map((tool) => ({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: tool.parameters ?? tool.inputSchema ?? { type: "object", properties: {} },
    }));
}

const digest = (value) => createHash("sha256").update(String(value)).digest();
const json = (res, id, result) => {
  const body = JSON.stringify({ jsonrpc: "2.0", id, result });
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
};
const bodyOnly = (res, id, result) => {
  const body = JSON.stringify({ jsonrpc: "2.0", id, result });
  res.end(body);
};
const failure = (res, id, code, message) => {
  const body = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
};

/**
 * @param {{tools?: Array, onCall?: (call: {name: string, arguments: object}) => Promise<object>, log?: (message: string) => void}} [settings]
 */
export function createMcpBridge({ tools = [], onCall, log } = {}) {
  let advertised = mcpTools(tools);
  let server;
  let token = "";
  let closed = false;
  const sockets = new Set();
  const expected = () => digest(token);

  function authorized(req) {
    const header = req.headers.authorization ?? "";
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    // Hash both sides so timingSafeEqual always compares equal-length buffers, whatever the caller sent.
    return timingSafeEqual(digest(header.slice(7)), expected());
  }

  async function handle(req, res) {
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); res.end(); return; }
    if (!authorized(req)) { res.writeHead(401, { "www-authenticate": "Bearer" }); res.end(); return; }
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) { res.writeHead(413); res.end(); return; }
    }
    let message;
    try { message = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
    if (message?.jsonrpc !== "2.0" || typeof message.method !== "string") { res.writeHead(400); res.end(); return; }
    const id = message.id ?? null;
    switch (message.method) {
      case "initialize":
        json(res, id, {
          protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: "1.0.0" },
        });
        return;
      case "notifications/initialized":
      case "notifications/cancelled":
        json(res, id, {});
        return;
      case "ping":
        json(res, id, {});
        return;
      case "tools/list":
        json(res, id, { tools: advertised.map((tool) => ({ ...tool })) });
        return;
      case "tools/call": {
        const name = message.params?.name;
        if (!advertised.some((tool) => tool.name === name)) {
          failure(res, id, -32602, `unknown Steak DSH tool "${String(name)}"`);
          return;
        }
        // Flush HTTP headers before the (possibly long) harness round trip. agy's HTTP MCP client drops a
        // request with no headers after ~60 s; periodic whitespace keeps the chunked response alive. JSON
        // parsers ignore the leading/trailing whitespace, so the final body is still one JSON-RPC message.
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache", "x-accel-buffering": "no" });
        const keepAlive = setInterval(() => { if (!res.writableEnded) res.write("\n"); }, 15_000);
        keepAlive.unref?.();
        try {
          const answer = await onCall?.({ name, arguments: message.params?.arguments ?? {} });
          clearInterval(keepAlive);
          bodyOnly(res, id, {
            content: [{ type: "text", text: typeof answer?.text === "string" ? answer.text : "tool finished" }],
            ...(answer?.isError ? { isError: true } : {}),
          });
        } catch (error) {
          clearInterval(keepAlive);
          // An MCP-level error result, not a transport failure: agy can give the model the failure as a tool result.
          bodyOnly(res, id, { content: [{ type: "text", text: error?.message ?? String(error) }], isError: true });
        }
        return;
      }
      default:
        failure(res, id, -32601, `method not found: ${message.method}`);
    }
  }

  return {
    /** Start listening. Never published outside loopback; the port is chosen by the OS. */
    start() {
      if (closed) throw new Error("MCP bridge is closed");
      return new Promise((resolve, reject) => {
        token = randomBytes(32).toString("base64url");
        server = createServer((req, res) => { void handle(req, res).catch((error) => { log?.(`mcp bridge: ${error?.message ?? error}`); if (!res.headersSent) res.writeHead(500); res.end(); }); });
        server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve({ type: "http", name: MCP_SERVER_NAME, url: `http://127.0.0.1:${server.address().port}/mcp`, headers: [{ name: "Authorization", value: `Bearer ${token}` }] });
        });
      });
    },
    /** Tools can arrive after the session starts (the harness knows them at prompt time). */
    setTools(next) { advertised = mcpTools(next); },
    get token() { return token; },
    get url() { return server?.address()?.port ? `http://127.0.0.1:${server.address().port}/mcp` : undefined; },
    close() {
      closed = true;
      if (!server) return Promise.resolve();
      return new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}
