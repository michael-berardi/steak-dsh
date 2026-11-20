/**
 * One long-lived `agy acp` session per Steak DSH session. The ACP prompt stays open across harness turns: when the
 * agent calls one of the host's MCP tools, the call is parked until the harness has executed that tool through its
 * own approval/owned-path pipeline and passed the result back on the next turn. agy's native tools are off (minimal
 * agent); agy's sign-in and settings are its own.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
import { AgyError, CODES, cleanAgyText } from "../errors.js";
import { killGroup, resolveAgy, stopGroup } from "../cli.js";
import { JsonRpc } from "./jsonrpc.js";
import { createMcpBridge, MCP_SERVER_NAME } from "./bridge.js";
import { createBridgeAgent } from "./agent.js";
import { acpError, canonicalEffort, normalizeUsage, parseSessionOptions } from "./protocol.js";

const TAIL = 16_384;
const PROGRESS_MAX = 120;
const flat = (text) => cleanAgyText(text).replace(/\s+/g, " ").trim().slice(0, PROGRESS_MAX);

const contentText = (content) => (Array.isArray(content) ? content : [])
  .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
  .join("");

/** Tiny async queue: updates arrive from the child process, the adapter consumes them as stream chunks. */
class Events {
  items = [];
  waiter;
  ended = false;
  push(event) { this.items.push(event); const wake = this.waiter; this.waiter = undefined; wake?.(); }
  end() { this.ended = true; const wake = this.waiter; this.waiter = undefined; wake?.(); }
  next(signal) {
    if (this.items.length) return Promise.resolve(this.items.shift());
    if (this.ended) return Promise.resolve({ kind: "end" });
    return new Promise((resolve, reject) => {
      const onAbort = () => { this.waiter = undefined; reject(new AgyError("agy ACP turn cancelled", CODES.CANCELLED)); };
      if (signal?.aborted) { onAbort(); return; }
      this.waiter = () => { signal?.removeEventListener("abort", onAbort); resolve(this.items.length ? this.items.shift() : { kind: "end" }); };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

const live = new Set();
let guarded = false;
function guardExit() {
  if (guarded) return;
  guarded = true;
  process.on("exit", () => { for (const child of live) killGroup(child); });
}

export class AcpSession {
  constructor({ env = process.env, report, approval } = {}) {
    this.env = env;
    this.report = report ?? (() => {});
    this.approval = approval;
    this.events = new Events();
    this.parked = new Map();
    this.toolSeq = 0;
    this.options = { efforts: [], models: [] };
    this.contextWindow = undefined;
    this.stderr = "";
    this.closed = false;
    this.child = undefined;
    this.rpc = undefined;
    this.bridge = undefined;
    this.agent = undefined;
    this.promptPromise = undefined;
  }

  async start({ model, effort, cwd, tools, signal }) {
    this.model = model;
    this.bridge = createMcpBridge({ tools, onCall: (call) => this.parkTool(call), log: (m) => this.report(`agy ACP: ${m}`) });
    const mcpServer = await this.bridge.start();
    try {
      this.agent = createBridgeAgent(this.env);
      const command = await resolveAgy(this.env);
      signal?.throwIfAborted();
      guardExit();
      const args = [
        "acp",
        "--agent", this.agent.agentName,
        "--process-per-session", // required by Google for HTTP MCP servers like our loopback bridge
        "--disable-telemetry",
        "--log-file", this.agent.logFile,
        "--add-dir", cwd,
      ];
      this.child = spawn(command, args, {
        cwd: this.agent.dir, env: { ...this.env },
        detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
      live.add(this.child);
      this.child.once("error", (error) => this.events.push({ kind: "error", error:
        new AgyError(`could not start agy acp (${command}): ${error.message}`, CODES.FAILED, { cause: error }) }));
      this.child.once("exit", (code, sig) => {
        live.delete(this.child);
        this.events.push({ kind: "error", error: new AgyError(`agy acp exited ${sig ? `from ${sig}` : `with code ${code}`} before finishing${this.stderr.trim() ? `: ${flat(this.stderr)}` : ""}`, CODES.FAILED) });
      });
      this.child.stderr.setEncoding("utf8");
      this.child.stderr.on("data", (chunk) => {
        this.stderr = (this.stderr + chunk).slice(-TAIL);
        const notice = flat(chunk);
        if (notice && /\b(denied|permission|allow)\b/i.test(notice)) this.report(`agy: ${notice}`);
      });

      this.rpc = new JsonRpc({
        stdin: this.child.stdin,
        stdout: this.child.stdout,
        onNotification: (message) => this.onNotification(message),
        onServerRequest: (message) => this.onServerRequest(message),
        onError: (error) => this.events.push({ kind: "error", error: acpError(error, { model: this.model }) }),
      });
      const init = await this.rpc.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {}, // no fs, no terminal: agy cannot reach the host except through the bridge
        clientInfo: { name: "steak-dsh", title: "Steak DSH", version: VERSION },
      }, { signal });
      if (!init || Number(init.protocolVersion) !== 1) {
        throw new AgyError(`agy ACP negotiated protocol version ${init?.protocolVersion ?? "none"}, expected 1`, CODES.ACP_PROTOCOL);
      }
      if (!init.agentCapabilities?.mcpCapabilities?.http) {
        throw new AgyError("agy ACP did not advertise HTTP MCP support (--process-per-session is required for the loopback tool bridge)", CODES.ACP_BRIDGE);
      }
      const created = await this.rpc.request("session/new", {
        cwd,
        mcpServers: [mcpServer],
        _meta: { antigravity: { systemPrompt: { append:
          "You are the model of a Steak DSH session. The harness owns the conversation and runs every tool through its own approval and owned-path checks. Use only the steak-dsh-tools MCP tools; no other tool is available." } } },
      }, { signal });
      if (!created?.sessionId || typeof created.sessionId !== "string") {
        throw new AgyError("agy ACP session/new returned no sessionId", CODES.ACP_PROTOCOL);
      }
      this.sessionId = created.sessionId;
      this.options = parseSessionOptions(created.configOptions);
      await this.configure(model, effort, signal);
      return this;
    } catch (error) {
      await this.close();
      throw acpError(error, { model });
    }
  }

  async configure(model, effort, signal) {
    const set = async (configId, value) => {
      if (!configId || value === undefined || value === null || value === "") return;
      const answer = await this.rpc.request("session/set_config_option", {
        sessionId: this.sessionId, configId, value,
      }, { signal });
      if (Array.isArray(answer?.configOptions)) this.options = parseSessionOptions(answer.configOptions);
    };
    if (this.options.modelOptionId) {
      const offered = this.options.models?.some((entry) => entry.id === model);
      if (!offered) {
        throw new AgyError(`agy ACP session does not offer model "${model}"; run \`steak-dsh models --provider agy\` to see what the plan offers`, CODES.MODEL_UNAVAILABLE);
      }
      await set(this.options.modelOptionId, model);
    }
    if (effort !== undefined && effort !== null && effort !== "") {
      const wanted = canonicalEffort(String(effort).toLowerCase() === "off" ? "low" : effort);
      const value = this.options.efforts.find((entry) => entry.id === wanted)?.value;
      if (value === undefined) {
        throw new AgyError(`agy ACP session does not offer reasoning effort "${effort}"${this.options.efforts.length ? `; it offers ${this.options.efforts.map((e) => e.id).join(", ")}` : ""}`, CODES.BAD_REQUEST);
      }
      await set(this.options.effortOptionId, value);
    }
  }

  onNotification(message) {
    if (message.method !== "session/update" || message.params?.sessionId !== this.sessionId) return;
    const update = message.params.update;
    if (!update || typeof update !== "object") return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "user_message_chunk": {
        const text = contentText(update.content);
        if (text) this.events.push({ kind: "text", text });
        break;
      }
      case "agent_thought_chunk": {
        const text = contentText(update.content);
        if (text) this.events.push({ kind: "reasoning", text });
        break;
      }
      case "usage_update": {
        const { usage, contextWindow } = normalizeUsage(update);
        if (contextWindow) this.contextWindow = contextWindow; // the server's real window, learned at first inference
        if (usage) this.events.push({ kind: "usage", usage });
        break;
      }
      case "config_option_update":
        if (Array.isArray(update.configOptions)) this.options = parseSessionOptions(update.configOptions);
        break;
      case "tool_call":
      case "tool_call_update": {
        const name = String(update.name ?? update.title ?? "tool");
        // The authoritative invocation is the MCP tools/call; this is only a display line.
        this.events.push({ kind: "text", text: `[agy tool: ${flat(name)}${update.status && update.status !== "completed" ? ` ${flat(update.status)}` : ""}]\n` });
        break;
      }
      case "notice":
        if (typeof update.message === "string") this.report(`agy: ${flat(update.message)}`);
        break;
      default: break;
    }
  }

  async onServerRequest(message) {
    if (message.method === "session/request_permission") {
      const call = message.params?.toolCall ?? {};
      const options = Array.isArray(message.params?.options) ? message.params.options : [];
      const allow = options.find((option) => String(option?.kind ?? "").startsWith("allow"));
      const reject = options.find((option) => String(option?.kind ?? "").startsWith("reject"));
      // Default deny: no native tools exist in this agent, and MCP tools are approved by the DSH harness itself.
      let granted = false;
      try {
        const decision = await this.approval?.({
          title: String(call.title ?? "agy tool"),
          name: String(call.name ?? ""),
          rawInput: call.rawInput,
          options,
        });
        granted = decision === true || (typeof decision === "string" && String(allow?.optionId) === decision);
      } catch { granted = false; }
      // Only ever select an option agy offered; with no matching option, answer "cancelled" (ACP's refusal without a choice).
      const chosen = granted ? allow : reject;
      return chosen ? { outcome: { outcome: "selected", optionId: chosen.optionId } } : { outcome: { outcome: "cancelled" } };
    }
    // Capabilities we never advertised: refuse instead of granting a side channel around the harness.
    throw { code: -32601, message: `Steak DSH does not grant ACP ${message.method}` };
  }

  parkTool(call) {
    if (this.closed) return Promise.reject(new Error("ACP session is closed"));
    const id = `acp-${++this.toolSeq}`;
    return new Promise((resolve, reject) => {
      this.parked.set(id, { ...call, resolve, reject });
      this.events.push({ kind: "tool", id, name: call.name, args: call.arguments ?? {} });
    });
  }

  /** The harness ran the tool; hand the MCP tools/call its result (or error) and let the ACP turn continue. */
  deliverToolResult(id, text, isError) {
    const call = this.parked.get(id);
    if (!call) return false;
    this.parked.delete(id);
    call.resolve({ text: String(text ?? ""), isError: Boolean(isError) });
    return true;
  }

  failParked(error) {
    for (const call of this.parked.values()) call.reject(error);
    this.parked.clear();
  }

  sendPrompt(text, { signal } = {}) {
    if (this.promptPromise) throw new AgyError("agy ACP already has a prompt in flight", CODES.ACP_PROTOCOL);
    signal?.addEventListener("abort", () => {
      if (!this.closed) this.rpc.notify("session/cancel", { sessionId: this.sessionId });
    }, { once: true });
    this.promptPromise = this.rpc.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    }, { signal }).then(
      (result) => { this.promptPromise = undefined; this.events.push({ kind: "done", result }); },
      (error) => { this.promptPromise = undefined; this.events.push({ kind: "error", error: acpError(error, { model: this.model }) }); },
    );
  }

  /** Stream updates as they arrive. The final internal chunk reports how the turn ended. */
  async *pump(signal) {
    let text = "";
    let reasoning = "";
    let textOpen = false;
    let reasoningOpen = false;
    let pending = [];
    const flush = function* () {
      if (pending.length) { yield* pending; pending = []; }
    };
    const closeBlocks = function* () {
      if (textOpen) { pending.push({ type: "block-end", index: 0, block: { type: "text", text } }); textOpen = false; }
      if (reasoningOpen) { pending.push({ type: "block-end", index: 1, block: { type: "reasoning", text: reasoning } }); reasoningOpen = false; }
      yield* flush();
    };
    const emit = (kind, value) => {
      if (kind === "reasoning") {
        if (!reasoningOpen) { reasoningOpen = true; pending.push({ type: "block-start", index: 1, blockType: "reasoning" }); }
        reasoning += value;
        pending.push({ type: "reasoning-delta", index: 1, text: value });
      } else {
        if (!textOpen) { textOpen = true; pending.push({ type: "block-start", index: 0, blockType: "text" }); }
        text += value;
        pending.push({ type: "text-delta", index: 0, text: value });
      }
    };
    for (;;) {
      const event = await this.events.next(signal);
      if (event.kind === "text" || event.kind === "reasoning") { emit(event.kind, event.text); yield* flush(); continue; }
      if (event.kind === "usage") { pending.push({ type: "usage", usage: event.usage }); yield* flush(); continue; }
      if (event.kind === "tool") {
        const tools = [{ id: event.id, name: event.name, args: event.args }];
        // Parallel MCP tools/call requests land a few milliseconds apart. A short settling window groups them
        // into one normal harness turn; events of other kinds stay queued for the next pump.
        await new Promise((resolve) => setTimeout(resolve, 60));
        if (signal?.aborted) throw new AgyError("agy ACP turn cancelled", CODES.CANCELLED);
        const rest = [];
        for (const queued of this.events.items.splice(0)) {
          if (queued.kind === "tool") tools.push({ id: queued.id, name: queued.name, args: queued.args });
          else rest.push(queued);
        }
        this.events.items.unshift(...rest);
        yield* closeBlocks();
        yield { type: "__boundary", boundary: "tools", tools };
        return;
      }
      if (event.kind === "error") { yield* closeBlocks(); throw event.error; }
      if (event.kind === "end") {
        yield* closeBlocks();
        throw new AgyError("agy ACP closed the connection during a prompt", CODES.ACP_PROTOCOL);
      }
      if (event.kind === "done") {
        yield* closeBlocks();
        const reason = event.result?.stopReason ?? "end_turn";
        if (reason === "cancelled") throw new AgyError("agy ACP turn cancelled", CODES.CANCELLED);
        if (reason !== "end_turn" && reason !== "max_tokens" && reason !== "max_turn_requests") {
          throw new AgyError(`agy ACP stopped with "${reason}"${event.result?.message ? `: ${flat(event.result.message)}` : ""}`, CODES.FAILED);
        }
        yield { type: "__boundary", boundary: "done", reason, options: this.options, contextWindow: this.contextWindow };
        return;
      }
    }
  }

  async close() {
    if (this.closed) return;
    // A prompt still in flight is cancelled at the agent before the connection goes: an abort that closes the session in
    // the same tick as its abort listener must never skip session/cancel (seen under full-suite load).
    if (this.promptPromise && this.sessionId) { try { this.rpc?.notify("session/cancel", { sessionId: this.sessionId }); } catch { /* connection already gone */ } }
    this.closed = true;
    const parked = new AgyError("ACP session closed while a tool call was pending", CODES.CANCELLED);
    const hadParked = this.parked.size > 0;
    this.failParked(parked);
    // Let an error answer reach any parked MCP tools/call before the listener and the child are torn down.
    if (hadParked) await new Promise((resolve) => setTimeout(resolve, 250));
    this.events.end();
    this.rpc?.close();
    await this.bridge?.close().catch((error) => this.report(`agy ACP: bridge close failed: ${error.message}`));
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) await stopGroup(this.child);
    live.delete(this.child);
    this.agent?.dispose();
  }
}

export { MCP_SERVER_NAME };
