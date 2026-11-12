/**
 * The controller: owns one long-lived `dsh --profile sdk` child, speaks JSON-RPC to it, folds everything into the
 * pure state and answers the harness's approval and question requests.
 *
 *  - Cancel: the SDK wire has no per-turn cancel, so cancel is SIGINT to the child's process group, wait for exit
 *    (SIGKILL after a grace period), respawn, initialize, `session/resume` (the harness repairs an interrupted turn).
 *  - Fail closed: whenever the child dies, every pending approval and question is dropped and nothing is allowed.
 *  - The renderer never touches this module's I/O; `onChange` just asks the app to repaint.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { enrichMeta } from "./diff.js";
import { approvalPrompt, describeResult, promptKey, questionPrompt } from "./prompt.js";
import { JsonRpcClient } from "./rpc.js";
import { flattenEvent, initialState, reduce } from "./state.js";

const DEFAULTS = { initTimeoutMs: 120_000, killGraceMs: 4_000, shutdownGraceMs: 3_000 };

const withTimeout = (promise, ms, what) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
  promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});

export const HELP_NOTICE = "keys: enter send · ctrl+j / alt+enter newline · up/down history · ctrl+a/e/k/u/w/y edit · pgup/pgdn scroll · ctrl+o expand tool output · ctrl+t thinking · esc interrupt · ctrl+c clear or quit · ctrl+d quit. commands: /new, /resume <id>, /exit; any other /command goes to the harness (for example /compact).";

export class Controller {
  /**
   * @param {object} cfg
   * @param {string} cfg.bin dsh executable
   * @param {string[]} cfg.args the full argument list (profile sdk plus overlay patches)
   * @param {object} cfg.options parsed steak-dsh options (model, provider, effort, permission, sessionId, ...)
   * @param {string} cfg.cwd workspace for the session
   * @param {object} cfg.env environment for the child
   * @param {() => void} cfg.onChange repaint request
   * @param {(state) => void} [cfg.onExit] called once after quit
   */
  constructor({ bin, args, options, cwd, env, onChange = () => {}, timing = {}, newId = randomUUID }) {
    this.bin = bin;
    this.args = args;
    this.o = options;
    this.cwd = cwd;
    this.env = env;
    this.onChange = onChange;
    this.timing = { ...DEFAULTS, ...timing };
    this.newId = newId;
    const sessionId = options.sessionId ?? newId();
    this.state = initialState({ model: options.model ? `${options.provider}/${options.model}` : "", effort: options.effort, sessionId, cwd, contextWindow: options.contextWindow, resumed: options.sessionId !== undefined });
    this.child = undefined;
    this.rpc = undefined;
    this.stderrTail = "";
    this.expectedExit = false;
    this.pending = new Map(); // rpc id -> { resolve, prompt }
    this.restarting = undefined;
    this.quitting = false;
  }

  dispatch(action) {
    this.state = reduce(this.state, action);
    this.onChange();
  }

  /** Spawn the child and open the JSON-RPC link. Rejects when the executable cannot start. */
  spawnChild() {
    return new Promise((resolve, reject) => {
      let child;
      if (this.quitting) {
        reject(new Error("shutting down"));
        return;
      }
      if (!existsSync(this.cwd)) {
        reject(new Error(`working directory ${this.cwd} does not exist`));
        return;
      }
      try {
        child = spawn(this.bin, this.args, { stdio: ["pipe", "pipe", "pipe"], env: this.env, cwd: this.cwd, detached: true });
      } catch (error) {
        reject(new Error(`could not start dsh (${this.bin}): ${error.message}`));
        return;
      }
      let settled = false;
      child.once("error", (error) => { if (!settled) { settled = true; reject(new Error(`could not start dsh (${this.bin}): ${error.message}`)); } });
      child.once("spawn", () => { settled = true; resolve(child); });
    }).then((child) => {
      this.child = child;
      this.stderrTail = "";
      this.expectedExit = false;
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => { this.stderrTail = (this.stderrTail + d).slice(-2000); });
      child.stdin.on("error", () => {});
      const rpc = new JsonRpcClient({ input: child.stdout, output: child.stdin }, {
        onNotification: (method, params) => this.onNotification(method, params),
        onRequest: (method, params, id) => this.onRequest(method, params, id),
      });
      this.rpc = rpc;
      this.exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
      child.once("exit", (code, signal) => this.onChildExit(child, code, signal));
      return child;
    });
  }

  onChildExit(child, code, signal) {
    if (this.child !== child) return;
    this.rpc?.close(new Error("harness exited"));
    this.dropPrompts();
    this.child = undefined;
    if (this.expectedExit) return;
    const tail = this.stderrTail.trim().split("\n").filter(Boolean).at(-1);
    const how = signal ? `harness stopped by ${signal}` : `harness exited with code ${code}`;
    this.dispatch({ type: "childExit", reason: tail ? `${how} (${tail.slice(0, 160)})` : how });
  }

  /** Fail closed: forget every open prompt. The child is gone, so nothing can be allowed after this. */
  dropPrompts() {
    for (const { resolve } of this.pending.values()) resolve({ settled: false });
    this.pending.clear();
  }

  initParams() {
    const o = this.o;
    const params = { cwd: this.cwd, provider: o.provider, model: o.model, approvalRequests: true, capabilities: { userQuestions: true } };
    const effort = o.effortWire ?? o.effort;
    if (effort !== undefined && effort !== "off") params.reasoningEffort = effort;
    return params;
  }

  /** initialize, then resume when the session already exists, then apply --permission. */
  async handshake({ resume }) {
    await withTimeout(this.rpc.request("initialize", this.initParams()), this.timing.initTimeoutMs, "initialize");
    if (resume) {
      try {
        await this.rpc.request("session/resume", { sessionId: this.state.sessionId });
      } catch (error) {
        this.dispatch({ type: "notice", text: `session ${this.state.sessionId.slice(0, 8)} could not be resumed (${error.message}); continuing under the same id` });
      }
    }
    if (this.o.permission && this.o.permission !== "workspace-write") {
      try {
        await this.rpc.request("session/query", { sessionId: this.state.sessionId, contentBlocks: [{ type: "text", text: `/permission ${this.o.permission}` }] });
      } catch (error) {
        this.dispatch({ type: "notice", text: `--permission ${this.o.permission} could not be applied (${error.message}); the harness default stays in force` });
      }
    }
  }

  async start() {
    try {
      await this.spawnChild();
      await this.handshake({ resume: this.o.sessionId !== undefined });
      this.dispatch({ type: "ready", detail: this.o.sessionId !== undefined ? "resumed" : "new session" });
      if (this.o.addDirs?.length) this.dispatch({ type: "notice", text: "--add-dir is not available over the SDK wire and was ignored" });
    } catch (error) {
      this.expectedExit = true;
      await this.killChild("SIGTERM");
      this.dispatch({ type: "error", message: `harness did not start: ${error.message}` });
      this.dispatch({ type: "childExit", reason: "harness is not running" });
    }
  }

  /** Respawn after a cancel or a crash and resume the same session. */
  async restart() {
    if (this.restarting) return this.restarting;
    this.restarting = (async () => {
      await this.spawnChild();
      await this.handshake({ resume: true });
    })().finally(() => { this.restarting = undefined; });
    return this.restarting;
  }

  // ---- inbound -----------------------------------------------------------------------------------------------

  onNotification(method, params) {
    if (method === "user-question.cancelled") {
      for (const [id, entry] of this.pending) {
        if (entry.prompt.requestId === params?.requestId) { this.pending.delete(id); entry.resolve({ settled: false }); this.dispatch({ type: "promptDone" }); }
      }
      return;
    }
    if (method === "session.event" && params?.event) {
      const event = flattenEvent(params.event);
      params = { ...params, event: event.type === "tool/result" && event.meta ? { ...event, meta: enrichMeta(event.meta, this.state.cwd) } : event };
    }
    this.dispatch({ type: "notification", method, params });
  }

  onRequest(method, params, id) {
    if (method !== "approval/request" && method !== "user-question/ask") return undefined;
    // A subagent's request carries another session id; it is still a human decision, so it is shown.
    const prompt = method === "approval/request" ? approvalPrompt(params, id) : questionPrompt(params, id);
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, prompt });
      this.dispatch({ type: "prompt", prompt });
    }).then((outcome) => {
      if (outcome?.settled === false) return undefined; // child gone or request withdrawn: no reply is sent
      return outcome.result;
    });
  }

  /** Route a key/text/paste event to the open prompt. Returns true when a prompt consumed it. */
  promptEvent(event) {
    const prompt = this.state.prompt;
    if (!prompt) return false;
    const { prompt: next, result } = promptKey(prompt, event);
    if (result !== undefined) {
      const entry = this.pending.get(prompt.rpcId);
      this.pending.delete(prompt.rpcId);
      this.dispatch({ type: "promptDone" });
      this.dispatch({ type: "notice", text: describeResult(prompt, result) });
      entry?.resolve({ settled: true, result });
    } else if (next !== prompt) {
      this.pending.get(prompt.rpcId) && (this.pending.get(prompt.rpcId).prompt = next);
      this.dispatch({ type: "promptUpdate", prompt: next });
    }
    return true;
  }

  // ---- outbound ----------------------------------------------------------------------------------------------

  /** Send one line from the editor. Slash commands that are not local go to the harness's command router. */
  async submit(text) {
    const trimmed = text.trim();
    if (trimmed === "/exit" || trimmed === "/quit") return { quit: true };
    if (trimmed === "/help") { this.dispatch({ type: "notice", text: HELP_NOTICE }); return {}; }
    if (trimmed === "/new") {
      this.dispatch({ type: "newSession", sessionId: this.newId() });
      this.dispatch({ type: "ready", detail: "new session" });
      return {};
    }
    const resumeMatch = /^\/resume\s+(\S+)$/.exec(trimmed);
    if (resumeMatch) return this.resumeSession(resumeMatch[1]);
    try {
      if (!this.child) {
        this.dispatch({ type: "footer", text: "restarting the harness…" });
        await this.restart();
        this.dispatch({ type: "restarted" });
        this.dispatch({ type: "footer", text: "" });
      }
      if (trimmed.startsWith("/")) {
        this.dispatch({ type: "command", text: trimmed, compact: /^\/compact\b/.test(trimmed) });
        await this.rpc.request("session/query", { sessionId: this.state.sessionId, contentBlocks: [{ type: "text", text: trimmed }] });
      } else {
        this.dispatch({ type: "submit", text });
        await this.rpc.request("session/prompt", { sessionId: this.state.sessionId, contentBlocks: [{ type: "text", text }] });
      }
    } catch (error) {
      this.dispatch({ type: "footer", text: "" });
      if (this.child) this.dispatch({ type: "error", message: `send failed: ${error.message}` });
    }
    return {};
  }

  async resumeSession(id) {
    try {
      if (!this.child) { await this.restart(); this.dispatch({ type: "restarted" }); }
      this.dispatch({ type: "newSession", sessionId: id });
      await this.rpc.request("session/resume", { sessionId: id });
      this.dispatch({ type: "ready", detail: "resumed" });
      this.dispatch({ type: "notice", text: `resumed session ${id}; earlier messages are not replayed on the SDK wire` });
    } catch (error) {
      this.dispatch({ type: "error", message: `resume failed: ${error.message}` });
    }
    return {};
  }

  // ---- cancel / shutdown -------------------------------------------------------------------------------------

  signalGroup(signal) {
    const child = this.child;
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
  }

  async killChild(signal) {
    const child = this.child;
    if (!child) return;
    this.signalGroup(signal);
    const exit = this.exited;
    const timer = setTimeout(() => this.signalGroup("SIGKILL"), this.timing.killGraceMs);
    await exit;
    clearTimeout(timer);
    this.child = undefined;
  }

  /** Cancel the running turn: SIGINT, respawn, resume. Pending prompts are refused first (fail closed). */
  async cancel() {
    if (this.cancelling || !this.child || !(this.state.busy || this.state.prompt)) return false;
    this.cancelling = true;
    try {
      this.dispatch({ type: "cancelRequested" });
      for (const [id, entry] of this.pending) {
        const outcome = entry.prompt.kind === "approval" ? { outcome: "rejected" } : { cancelled: true };
        this.rpc.reply(id, outcome);
        entry.resolve({ settled: false });
      }
      this.pending.clear();
      this.expectedExit = true;
      this.rpc.close(new Error("turn cancelled"));
      await this.killChild("SIGINT");
      if (this.quitting) return true; // the user quit while the cancel was in flight: do not respawn
      await this.restart();
      this.dispatch({ type: "cancelled" });
    } catch (error) {
      this.dispatch({ type: "childExit", reason: `could not restart the harness after the cancel (${error.message})` });
    } finally {
      this.cancelling = false;
    }
    return true;
  }

  /** Orderly shutdown: protocol `shutdown`, close stdin, then SIGTERM and SIGKILL if it lingers. */
  async quit() {
    if (this.quitting) return;
    this.quitting = true;
    this.expectedExit = true;
    this.dropPrompts();
    await this.restarting?.catch(() => {}); // a respawn already under way finishes first, then is shut down below
    const child = this.child;
    if (!child) return;
    try { await withTimeout(this.rpc.request("shutdown"), this.timing.shutdownGraceMs, "shutdown"); } catch { /* fall through to signals */ }
    try { child.stdin.end(); } catch { /* ignore */ }
    const exited = await Promise.race([this.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), this.timing.shutdownGraceMs))]);
    if (!exited) await this.killChild("SIGTERM");
    this.child = undefined;
    this.rpc?.close(new Error("shutdown"));
  }
}
