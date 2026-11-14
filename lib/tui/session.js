/**
 * The controller: owns one long-lived `dsh --profile sdk` child, speaks JSON-RPC to it, folds everything into the
 * pure state and answers the harness's approval and question requests.
 *
 *  - Cancel: the SDK wire has no per-turn cancel, so cancel is SIGINT to the child's process group, wait for exit
 *    (SIGKILL after a grace period), respawn, initialize, `session/resume` (the harness repairs an interrupted turn).
 *  - Fail closed: whenever the child dies, every pending approval and question is dropped and nothing is allowed.
 *  - A child that dies is reported with its cause: the first error line of its stderr and the top stack frame, and
 *    the whole stderr tail in a private log file the notice names. Two identical failures in a row on the same
 *    session stop the restarts: the session id stays on screen and `/new` starts a fresh session.
 *  - Permissions: `/permission <preset>` is sent before the first prompt of every session and after every resume
 *    and restart, so the preset (and the approval policy the overlay ties to it) is in force before the model runs.
 *  - The renderer never touches this module's I/O; `onChange` just asks the app to repaint.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { enrichMeta } from "./diff.js";
import { approvalPrompt, describeResult, promptKey, questionPrompt } from "./prompt.js";
import { JsonRpcClient } from "./rpc.js";
import { flattenEvent, initialState, reduce } from "./state.js";

const DEFAULTS = { initTimeoutMs: 120_000, killGraceMs: 4_000, shutdownGraceMs: 3_000 };
/** How much of the child's stderr is kept: enough for a full Node stack and the harness's own diagnostics. */
export const STDERR_KEEP = 64 * 1024;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The cause of a child's death from its stderr tail: the first error line (Node's uncaught-exception header, or the
 * harness's own "dsh: fatal ...: Error: ..." line) and the first stack frame after it, with the install prefix of
 * the path cut. Node's version banner is never the cause. Without an error line, the last meaningful line.
 */
export function summarizeStderr(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim() && !/^Node\.js v\d/.test(line.trim()));
  const errorAt = lines.findIndex((line) => /^(?:\S+: fatal [^:]+: )?(?:Uncaught )?(?:[A-Z][A-Za-z]*)?(?:Error|Exception)\b/.test(line.trim()));
  if (errorAt < 0) return { headline: lines.at(-1)?.trim().slice(0, 300) };
  const frame = lines.slice(errorAt + 1).find((line) => /^\s+at\s/.test(line));
  return {
    headline: lines[errorAt].trim().slice(0, 300),
    frame: frame?.trim().replace(/(\(|\s)(?:file:\/\/)?\/[^()\s]*node_modules\//, "$1").slice(0, 200),
  };
}

/** Where exit logs go: `$DSH_HOME/steak-dsh/logs` (the harness home this tool already keeps its settings in). */
export function exitLogDir(env = process.env) {
  const home = (env.DSH_HOME ?? "").trim() || join(homedir(), ".dsh");
  return join(home, "steak-dsh", "logs");
}

/** The key that makes two approval requests "the same" for an Allow-for-this-session rule. */
export function approvalRuleKey(params) {
  const reason = typeof params?.reason === "string" ? params.reason : "";
  const escalation = /^escalate sandbox to ([a-z-]+)(?::|$)/.exec(reason);
  return [String(params?.sessionId ?? ""), String(params?.toolName ?? "tool"), escalation ? `sandbox:${escalation[1]}` : `reason:${reason}`].join("\u0000");
}

export function ruleLabel(key) {
  const [, tool, scope] = key.split("\u0000");
  return scope.startsWith("sandbox:") ? `${tool} → ${scope.slice(8)}` : tool;
}

export function stuckText(stuck) {
  return `not restarting: the harness failed twice the same way on session ${stuck.sessionId} (${stuck.cause}). ` +
    `Type /new to start a new session; session ${stuck.sessionId} stays on disk and /resume ${stuck.sessionId} tries it again.`;
}

const withTimeout = (promise, ms, what) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
  promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});

export const HELP_NOTICE = "keys: enter send · ctrl+j / alt+enter newline · up/down history · ctrl+a/e/k/u/w/y edit · pgup/pgdn scroll · ctrl+o expand tool output · ctrl+t thinking · esc interrupt · ctrl+c clear or quit · ctrl+d quit. approval prompt: y allow once · a allow for this session · n/esc reject. commands: /new, /resume <id>, /permission <preset>, /exit; any other /command goes to the harness (for example /compact).";

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
  constructor({ bin, args, prepare, options, cwd, env, onChange = () => {}, timing = {}, newId = randomUUID, publisher, logDir, now = Date.now }) {
    this.bin = bin;
    this.args = args;
    // Called before every spawn; returns the argument list (tui rewrites an overlay file a temp cleaner removed).
    this.prepare = prepare;
    this.logDir = logDir ?? exitLogDir(env);
    this.now = now;
    this.o = options;
    this.cwd = cwd;
    this.env = env;
    this.onChange = onChange;
    this.timing = { ...DEFAULTS, ...timing };
    this.newId = newId;
    const sessionId = options.sessionId ?? newId();
    this.state = initialState({ model: options.model ? `${options.provider}/${options.model}` : "", effort: options.effort, sessionId, cwd, contextWindow: options.contextWindow, price: options.price, resumed: options.sessionId !== undefined });
    this.child = undefined;
    this.rpc = undefined;
    this.stderrTail = "";
    this.sessionKnown = options.sessionId !== undefined; // the harness has (or had) this session: restarts resume it
    this.permissionFor = undefined; // the session id /permission was last applied to
    this.applyingPermission = false;
    this.lastFailure = undefined; // { key } of the last abnormal exit, for the crash-loop guard
    this.stuck = undefined; // { sessionId, cause } once the same failure happened twice in a row
    this.sessionRules = new Map(); // approvalRuleKey -> label: "Allow for this session" answers
    this.exitLogs = 0;
    this.expectedExit = false;
    this.pending = new Map(); // rpc id -> { resolve, prompt }
    this.restarting = undefined;
    this.quitting = false;
    // Optional host-facing transcript (see transcript-publisher.js). Its notices land in the conversation.
    this.publisher = publisher;
    publisher?.start((text) => this.dispatch({ type: "notice", text }));
  }

  dispatch(action) {
    const prev = this.state;
    this.state = reduce(prev, action);
    this.publisher?.observe(action, prev, this.state);
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
      let args = this.args;
      try {
        if (this.prepare) args = this.prepare();
      } catch (error) {
        reject(new Error(`could not prepare the harness arguments: ${error.message}`));
        return;
      }
      this.spawnedArgs = args;
      try {
        child = spawn(this.bin, args, { stdio: ["pipe", "pipe", "pipe"], env: this.env, cwd: this.cwd, detached: true });
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
      this.childPhase = "startup";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => { this.stderrTail = (this.stderrTail + d).slice(-STDERR_KEEP); });
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
    const refused = this.pending.size;
    this.dropPrompts();
    this.child = undefined;
    if (this.expectedExit) return;
    const how = `${signal ? `harness stopped by ${signal}` : `harness exited with code ${code}`}${this.childPhase === "running" ? "" : ` during ${this.childPhase}`}`;
    const { headline, frame } = summarizeStderr(this.stderrTail);
    const cause = headline ? `${headline}${frame ? ` (${frame})` : ""}` : how;
    const log = this.writeExitLog({ code, signal, how });
    // The crash-loop guard: the same failure twice in a row on the same session means a restart will not help.
    const key = `${this.state.sessionId}\u0000${headline ?? how}`;
    if (this.lastFailure?.key === key) this.stuck = { sessionId: this.state.sessionId, cause };
    this.lastFailure = { key };
    const reason = `${how}${headline ? `: ${cause}` : ""}${log ? `; full log: ${log}` : ""}`;
    this.dispatch({ type: "childExit", reason, refused, stuck: this.stuck ? stuckText(this.stuck) : undefined });
  }

  /** The whole stderr tail of a dead child, in a private file (0600 in a 0700 folder). Returns its path or undefined. */
  writeExitLog({ code, signal, how }) {
    try {
      mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
      const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
      const file = join(this.logDir, `harness-exit-${stamp}-${process.pid}-${++this.exitLogs}.log`);
      const text = [
        `${how}`,
        `time: ${new Date(this.now()).toISOString()}`,
        `session: ${this.state.sessionId}`,
        `exit: ${signal ? `signal ${signal}` : `code ${code}`}`,
        `command: ${[this.bin, ...(this.spawnedArgs ?? this.args ?? [])].join(" ")}`,
        `cwd: ${this.cwd}`,
        `--- stderr (last ${this.stderrTail.length} characters) ---`,
        this.stderrTail,
      ].join("\n");
      writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600, flag: "wx" });
      return file;
    } catch {
      return undefined; // a log that cannot be written must not hide the notice
    }
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

  /** initialize, then resume when the session already exists and apply the permission preset to it. */
  async handshake({ resume }) {
    await withTimeout(this.rpc.request("initialize", this.initParams()), this.timing.initTimeoutMs, "initialize");
    if (resume) {
      this.childPhase = "resume";
      try {
        await this.rpc.request("session/resume", { sessionId: this.state.sessionId });
      } catch (error) {
        if (this.rpc.closed) throw error; // the child died while resuming: onChildExit reports it
        this.dispatch({ type: "notice", text: `session ${this.state.sessionId.slice(0, 8)} could not be resumed (${error.message}); continuing under the same id` });
      }
      this.sessionKnown = true;
      await this.applyPermission();
    }
    this.childPhase = "running";
  }

  /**
   * `/permission <preset>` for the current session. A new session gets the preset when the harness creates it (the
   * overlay makes it the default), so this matters for a resumed one; it is still sent before a new session's first
   * prompt so the order never depends on that. The harness's own completion notice is not shown.
   */
  async applyPermission() {
    const preset = this.o.permission ?? "danger-full-access";
    this.applyingPermission = true;
    try {
      const reply = await this.rpc.request("session/query", { sessionId: this.state.sessionId, contentBlocks: [{ type: "text", text: `/permission ${preset}` }] });
      const result = reply?.execution?.result;
      if (result?.kind === "error") this.dispatch({ type: "notice", text: `--permission ${preset} could not be applied (${result.text ?? "refused"}); the harness default stays in force` });
      this.permissionFor = this.state.sessionId;
      this.sessionKnown = true;
    } catch (error) {
      if (this.rpc.closed) throw error;
      this.dispatch({ type: "notice", text: `--permission ${preset} could not be applied (${error.message}); the harness default stays in force` });
    } finally {
      this.applyingPermission = false;
    }
  }

  /** Run the handshake; when the child died during it, wait until its exit was reported and mark the error so. */
  async handshakeOrReport(resume) {
    try {
      await this.handshake({ resume });
    } catch (error) {
      if (this.rpc?.closed) {
        await Promise.race([this.exited, delay(this.timing.killGraceMs)]);
        if (!this.child) error.reported = true;
      }
      throw error;
    }
  }

  /** Start once. A message typed before the handshake has answered waits on `starting` instead of failing. */
  start() {
    this.starting ??= this.startOnce().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  async startOnce() {
    try {
      await this.spawnChild();
      await this.handshakeOrReport(this.o.sessionId !== undefined);
      this.dispatch({ type: "ready", detail: this.o.sessionId !== undefined ? "resumed" : "new session" });
      if (this.o.addDirs?.length) this.dispatch({ type: "notice", text: "--add-dir is not available over the SDK wire and was ignored" });
    } catch (error) {
      if (error.reported) return; // the child died during startup and its exit notice names the cause
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
      await this.handshakeOrReport(this.sessionKnown);
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
    if (method === "session.query.completed" && this.applyingPermission && params?.sessionId === this.state.sessionId) return;
    if (method === "session.event" && params?.event) {
      const event = flattenEvent(params.event);
      if (event.type === "turn/end" && event.reason?.kind === "completed" && params.sessionId === this.state.sessionId) this.lastFailure = undefined;
      params = { ...params, event: event.type === "tool/result" && event.meta ? { ...event, meta: enrichMeta(event.meta, this.state.cwd) } : event };
    }
    this.dispatch({ type: "notification", method, params });
  }

  onRequest(method, params, id) {
    if (method !== "approval/request" && method !== "user-question/ask") return undefined;
    if (method === "approval/request") {
      const key = approvalRuleKey(params);
      if (this.sessionRules.has(key)) {
        this.dispatch({ type: "notice", text: `allowed for this session: ${ruleLabel(key)} (answered without asking)` });
        return { outcome: "allowed-once" };
      }
    }
    // A subagent's request carries another session id; it is still a human decision, so it is shown.
    const base = method === "approval/request" ? { ...approvalPrompt(params, id), ruleKey: approvalRuleKey(params) } : questionPrompt(params, id);
    const prompt = { ...base, openedAt: this.now() };
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
    const { prompt: next, result, remember } = promptKey(prompt, event);
    if (result !== undefined) {
      const entry = this.pending.get(prompt.rpcId);
      this.pending.delete(prompt.rpcId);
      this.dispatch({ type: "promptDone" });
      if (remember && prompt.kind === "approval" && prompt.ruleKey) {
        this.sessionRules.set(prompt.ruleKey, ruleLabel(prompt.ruleKey));
        this.dispatch({ type: "notice", text: `allowed for this session: ${ruleLabel(prompt.ruleKey)}; identical requests are answered without asking until you quit` });
        // Identical requests already waiting behind this one are answered by the same rule.
        for (const [rpcId, other] of [...this.pending]) {
          if (other.prompt.kind !== "approval" || other.prompt.ruleKey !== prompt.ruleKey) continue;
          this.pending.delete(rpcId);
          this.dispatch({ type: "promptDrop", rpcId });
          other.resolve({ settled: true, result: { outcome: "allowed-once" } });
        }
      } else {
        this.dispatch({ type: "notice", text: describeResult(prompt, result) });
      }
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
      this.sessionKnown = false;
      this.lastFailure = undefined;
      return {};
    }
    const resumeMatch = /^\/resume\s+(\S+)$/.exec(trimmed);
    if (resumeMatch) return this.resumeSession(resumeMatch[1]);
    const permissionMatch = /^\/permission\s+(\S+)$/.exec(trimmed);
    try {
      await this.starting; // never rejects: a failed start reports itself and leaves no child
      if (!this.child && this.stuck?.sessionId === this.state.sessionId) {
        this.dispatch({ type: "notice", text: stuckText(this.stuck) });
        return {};
      }
      if (!this.child) {
        this.dispatch({ type: "footer", text: "restarting the harness…" });
        await this.restart();
        this.dispatch({ type: "restarted" });
        this.dispatch({ type: "footer", text: "" });
      }
      if (!permissionMatch && this.permissionFor !== this.state.sessionId) await this.applyPermission();
      if (trimmed.startsWith("/")) {
        this.dispatch({ type: "command", text: trimmed, compact: /^\/compact\b/.test(trimmed) });
        const reply = await this.rpc.request("session/query", { sessionId: this.state.sessionId, contentBlocks: [{ type: "text", text: trimmed }] });
        this.sessionKnown = true;
        if (permissionMatch && reply?.execution?.result?.kind !== "error") {
          // The preset the user chose now: restarts and /new keep it.
          this.o = { ...this.o, permission: permissionMatch[1] };
          this.permissionFor = this.state.sessionId;
          this.dispatch({ type: "permission", permission: permissionMatch[1] });
        }
      } else {
        this.dispatch({ type: "submit", text });
        await this.rpc.request("session/prompt", { sessionId: this.state.sessionId, contentBlocks: [{ type: "text", text }] });
        this.sessionKnown = true;
      }
    } catch (error) {
      this.dispatch({ type: "footer", text: "" });
      if (error.reported) return {}; // the exit notice already names the cause
      if (this.rpc?.closed && this.child) await Promise.race([this.exited, delay(this.timing.killGraceMs)]);
      if (this.child) this.dispatch({ type: "error", message: `send failed: ${error.message}` });
    }
    return {};
  }

  async resumeSession(id) {
    try {
      await this.starting;
      if (this.stuck?.sessionId === id) this.stuck = undefined; // an explicit /resume is a deliberate retry
      this.lastFailure = undefined;
      // A restart here resumes nothing: the old session may be the one that keeps failing.
      if (!this.child) { this.sessionKnown = false; await this.restart(); this.dispatch({ type: "restarted" }); }
      this.dispatch({ type: "newSession", sessionId: id });
      await this.rpc.request("session/resume", { sessionId: id });
      this.sessionKnown = true;
      await this.applyPermission();
      this.dispatch({ type: "ready", detail: "resumed" });
      const note = `resumed session ${id}; earlier messages are not replayed on the SDK wire`;
      this.dispatch({ type: "notice", text: note });
      this.publisher?.note(note);
    } catch (error) {
      if (!error.reported) this.dispatch({ type: "error", message: `resume failed: ${error.message}` });
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
      if (!error.reported) this.dispatch({ type: "childExit", reason: `could not restart the harness after the cancel (${error.message})` });
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
