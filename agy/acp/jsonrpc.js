/**
 * The ACP stdio transport: newline-delimited JSON-RPC 2.0, as the protocol specifies. One connection per long-lived
 * `agy acp` process. Incoming notifications and agent-initiated requests (permissions) are dispatched to the session;
 * nothing here implements a tool or grants a capability.
 */
import { createInterface } from "node:readline";

export class AcpProtocolError extends Error {
  constructor(message, code = "AGY_ACP_PROTOCOL", options) {
    super(message, options);
    this.name = "AcpProtocolError";
    this.code = code;
  }
}

export class JsonRpc {
  constructor({ stdin, stdout, onNotification, onServerRequest, onError } = {}) {
    this.stdin = stdin;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.onNotification = onNotification ?? (() => {});
    this.onServerRequest = onServerRequest ?? (() => { throw new AcpProtocolError("unexpected agent request"); });
    this.onError = onError ?? (() => {});
    this.lines = createInterface({ input: stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.receive(line));
    stdin.on("error", (error) => { if (!this.closed) this.onError(error); });
  }

  receive(line) {
    if (!line.trim() || this.closed) return;
    let message;
    try { message = JSON.parse(line); } catch {
      this.onError(new AcpProtocolError("agy sent a line that is not JSON-RPC"));
      return;
    }
    if (message?.jsonrpc !== "2.0") {
      this.onError(new AcpProtocolError("agy sent a message without jsonrpc 2.0"));
      return;
    }
    if (message.id !== undefined && typeof message.method === "string") {
      Promise.resolve()
        .then(() => this.onServerRequest(message))
        .then((result) => this.send({ jsonrpc: "2.0", id: message.id, result: result ?? {} }),
          (error) => this.send({ jsonrpc: "2.0", id: message.id, error: {
            code: Number.isInteger(error?.code) ? error.code : -32603,
            message: String(error?.message ?? error).slice(0, 2000),
          } }))
        .catch((error) => this.onError(error));
      return;
    }
    if (message.id !== undefined) {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new AcpProtocolError(
        `agy ACP error ${message.error.code}: ${message.error.message ?? "no message"}`,
        undefined,
        { cause: message.error },
      ));
      else waiting.resolve(message.result);
      return;
    }
    try { this.onNotification(message); } catch (error) { this.onError(error); }
  }

  send(message) {
    if (this.closed) return;
    try { this.stdin.write(`${JSON.stringify(message)}\n`); } catch (error) { this.onError(error); }
  }

  request(method, params = {}, { signal } = {}) {
    if (this.closed) return Promise.reject(new AcpProtocolError("ACP connection is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const waiting = { resolve, reject };
      this.pending.set(id, waiting);
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.notify("$/cancel_request", { id });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve: (value) => { signal?.removeEventListener("abort", onAbort); resolve(value); },
        reject: (error) => { signal?.removeEventListener("abort", onAbort); reject(error); } });
      this.send({ jsonrpc: "2.0", id, method, params });
      // Cancellation is a notification: the agent still answers the original request (cancelled / -32800).
    });
  }

  notify(method, params = {}) { this.send({ jsonrpc: "2.0", method, params }); }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    for (const waiting of this.pending.values()) {
      waiting.reject(new AcpProtocolError("ACP connection closed before a response arrived"));
    }
    this.pending.clear();
  }
}
