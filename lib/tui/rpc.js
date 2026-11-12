/**
 * NDJSON JSON-RPC 2.0 client over a child's stdio: one message per newline-terminated line.
 * A frame with id and method is a request from the server, id alone a response, method alone a notification.
 * Malformed lines are ignored. close() rejects every pending request and fails nothing else.
 */
export class RpcError extends Error {
  constructor(message, code, data) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export class JsonRpcClient {
  /**
   * @param {{ input: NodeJS.ReadableStream, output: NodeJS.WritableStream }} io child stdout / child stdin
   * @param {{ onNotification?: Function, onRequest?: (method:string, params:any, id:any) => Promise<any>|any, onClose?: Function }} handlers
   */
  constructor({ input, output }, { onNotification, onRequest, onClose } = {}) {
    this.input = input;
    this.output = output;
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    this.onClose = onClose;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = "";
    this.closed = false;
    input.setEncoding?.("utf8");
    this.onData = (chunk) => this.feed(chunk);
    this.onEnd = () => this.close(new Error("harness closed the connection"));
    input.on("data", this.onData);
    input.on("end", this.onEnd);
    input.on("close", this.onEnd);
    output.on?.("error", () => this.close(new Error("harness stdin closed")));
  }

  feed(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.dispatch(line);
    }
  }

  dispatch(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message === null || typeof message !== "object") return;
    const hasId = message.id !== undefined && message.id !== null;
    if (hasId && typeof message.method === "string") {
      void this.serve(message);
    } else if (hasId) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new RpcError(message.error.message ?? "rpc error", message.error.code, message.error.data));
      else entry.resolve(message.result);
    } else if (typeof message.method === "string") {
      try { this.onNotification?.(message.method, message.params); } catch { /* a render fault must not kill the wire */ }
    }
  }

  async serve(message) {
    if (!this.onRequest) return this.reply(message.id, undefined, { code: -32601, message: `method not found: ${message.method}` });
    try {
      const result = await this.onRequest(message.method, message.params, message.id);
      if (result === undefined) this.reply(message.id, undefined, { code: -32601, message: `method not found: ${message.method}` });
      else this.reply(message.id, result);
    } catch (error) {
      this.reply(message.id, undefined, { code: -32603, message: String(error?.message ?? error) });
    }
  }

  reply(id, result, error) {
    this.write(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result });
  }

  write(message) {
    if (this.closed) return false;
    try {
      this.output.write(JSON.stringify(message) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error("harness is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const frame = { jsonrpc: "2.0", id, method };
      if (params !== undefined) frame.params = params;
      if (!this.write(frame)) {
        this.pending.delete(id);
        reject(new Error("harness is not running"));
      }
    });
  }

  close(reason = new Error("rpc client closed")) {
    if (this.closed) return;
    this.closed = true;
    this.input.removeListener("data", this.onData);
    this.input.removeListener("end", this.onEnd);
    this.input.removeListener("close", this.onEnd);
    for (const entry of this.pending.values()) entry.reject(reason);
    this.pending.clear();
    try { this.onClose?.(reason); } catch { /* ignore */ }
  }
}
