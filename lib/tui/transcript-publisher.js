/**
 * Publishes the conversation as a Pi-format session file so a host terminal app can show it in its own view.
 *
 * Opt-in through two environment variables, both set by the host: ULTRATERM_UI_TRANSCRIPT_FILE (absolute path ending
 * in `<id>.jsonl`) and ULTRATERM_UI_SESSION_ID (the `<id>`). Without them nothing is created and nothing is written.
 *
 * File format: a header `{"type":"session","version":3,"id","cwd"}`, then one JSON object per line, append-only, each
 * with a unique `id` and `parentId` = the previous row's id. Rows: user message, assistant text, assistant toolCall,
 * toolResult, and an assistant row with a `stopReason` that ends a turn. Reasoning text is never published.
 *
 * Safety: the folder is created 0700 (or must already be ours and not group/world writable), the file is 0600, the
 * final path is never followed if it is a symlink, and every row is one complete line in a single append. Any write
 * error stops publishing for the session with one notice; it never reaches the conversation.
 */
import { appendFileSync, closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { flattenEvent } from "./state.js";

export const ENV_FILE = "ULTRATERM_UI_TRANSCRIPT_FILE";
export const ENV_SESSION = "ULTRATERM_UI_SESSION_ID";
export const ENV_MAIN_SCREEN = "ULTRATERM_MAIN_SCREEN";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const textOf = (blocks) => (Array.isArray(blocks) ? blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "");
const num = (v) => (Number.isFinite(v) ? v : 0);
const cause = (error) => (error?.code ? `${error.code}${error.syscall ? ` on ${error.syscall}` : ""}` : String(error?.message ?? error).slice(0, 80));

/** The publisher for this environment, or undefined when neither variable is set. */
export function transcriptFromEnv(env, { cwd, now } = {}) {
  const file = env?.[ENV_FILE];
  const id = env?.[ENV_SESSION];
  if (!file && !id) return undefined;
  return new TranscriptPublisher({ file, id, cwd, now });
}

export class TranscriptPublisher {
  constructor({ file, id, cwd = "", now = () => Date.now() }) {
    this.file = file;
    this.id = id;
    this.cwd = cwd;
    this.now = now;
    this.onNotice = () => {};
    this.active = false;
    this.pendingNotice = undefined;
    this.resetRows();
  }

  resetRows() {
    this.count = 0;
    this.last = null;
    this.open = false; // a user row was published and no stop row has closed the turn yet
    this.usage = undefined; // usage of a message that had no row of its own yet
    this.names = new Map(); // callId -> tool name
  }

  /** Validate the target and write the header. Returns true when publishing is on; otherwise a notice says why. */
  start(onNotice = () => {}) {
    this.onNotice = onNotice;
    const problem = this.check();
    if (problem) { onNotice(`transcript not published to the host: ${problem}`); return false; }
    try {
      this.replace();
    } catch (error) {
      onNotice(`transcript not published to the host: could not create the transcript (${cause(error)})`);
      return false;
    }
    this.active = true;
    return true;
  }

  check() {
    const { file, id } = this;
    if (!file || !id) return `both ${ENV_FILE} and ${ENV_SESSION} are needed`;
    if (!isAbsolute(file)) return `${ENV_FILE} is not an absolute path`;
    if (/[\\/]/.test(id) || basename(file) !== `${id}.jsonl`) return `${ENV_FILE} does not end in the session id`;
    const uid = process.getuid?.();
    const dir = dirname(file);
    try {
      let st = lstatSync(dir, { throwIfNoEntry: false });
      if (!st) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        st = lstatSync(dir);
      }
      if (!st.isDirectory()) return "the transcript folder is not a folder";
      if (uid !== undefined && st.uid !== uid) return "the transcript folder is not owned by you";
      if ((st.mode & 0o022) !== 0) return "the transcript folder is group or world writable";
      const target = lstatSync(file, { throwIfNoEntry: false });
      if (target) {
        if (target.isSymbolicLink()) return "the transcript path is a symlink";
        if (!target.isFile()) return "the transcript path is not a regular file";
        if (uid !== undefined && target.uid !== uid) return "the transcript file is not owned by you";
      }
    } catch (error) {
      return `the transcript folder could not be used (${cause(error)})`;
    }
    return undefined;
  }

  /** Atomically put a file holding only the header at the path: temp file beside it, fsync, rename. */
  replace() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    this.resetRows();
    const lines = [JSON.stringify({ type: "session", version: 3, id: this.id, cwd: this.cwd })];
    let fd;
    try {
      fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      fchmodSync(fd, 0o600);
      writeSync(fd, `${lines.join("\n")}\n`);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, this.file);
    } catch (error) {
      if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(tmp); } catch { /* not created */ }
      throw error;
    }
  }

  fail(error) {
    if (!this.active) return;
    this.active = false;
    this.onNotice(`transcript publishing stopped (${cause(error)}); the session itself is unaffected`);
  }

  /** Append one row as a single complete line. */
  row(message, extra = {}) {
    const ms = this.now();
    const id = (++this.count).toString(16).padStart(8, "0");
    const entry = { type: "message", id, parentId: this.last, timestamp: new Date(ms).toISOString(), message: { ...message, timestamp: ms }, ...extra };
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { flag: constants.O_WRONLY | constants.O_APPEND | NOFOLLOW, mode: 0o600 });
    this.last = id;
  }

  assistant(content, extra = {}) {
    const message = { role: "assistant", content, ...extra };
    if (this.usage) { message.usage = this.usage; this.usage = undefined; }
    this.row(message);
  }

  userRow(text) {
    this.row({ role: "user", content: [{ type: "text", text }] });
    this.open = true;
  }

  /** The assistant row that ends a turn, after closing any tool call that never got a result. */
  stop(stopReason, errorMessage) {
    this.assistant([], errorMessage === undefined ? { stopReason } : { stopReason, errorMessage });
    this.open = false;
  }

  /** The note a resumed session starts with (a fresh file; earlier messages are not replayed on the SDK wire). */
  note(text) {
    if (!this.active) return;
    try {
      this.assistant([{ type: "text", text }], { stopReason: "stop" });
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Called by the controller after every dispatched action with the state before and after.
   * Never throws: a failure here stops publishing and nothing else.
   */
  observe(action, prev, next) {
    if (!this.active) return;
    try {
      this.publish(action, prev, next);
    } catch (error) {
      this.fail(error);
    }
  }

  publish(action, prev, next) {
    switch (action.type) {
      case "submit": return this.userRow(action.text);
      case "command": return this.userRow(action.text);
      case "newSession": return this.replace();
      case "cancelled": return this.interrupted(prev, next, "aborted");
      case "childExit": return this.interrupted(prev, next, "error", "harness exited");
      case "error": return this.interrupted(prev, next, "error", action.message);
      case "notification": break;
      default: return undefined;
    }
    const { method, params } = action;
    if (params?.sessionId !== prev.sessionId) return undefined;
    if (method === "session.status") {
      if (params.status === "idle" && this.open) this.stop("stop");
      return undefined;
    }
    if (method === "session.query.completed") {
      const text = typeof params.finalResponse === "string" ? params.finalResponse.trim() : "";
      if (text) this.assistant([{ type: "text", text }]);
      if (this.open) this.stop("stop");
      return undefined;
    }
    if (method !== "session.event") return undefined;
    const event = flattenEvent(params.event);
    switch (event?.type) {
      case "assistant/message": return this.message(event, prev, next);
      case "tool/call": {
        this.names.set(event.callId, event.name);
        const raw = typeof event.arguments === "string" ? safeParse(event.arguments) : event.arguments;
        const args = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { input: raw };
        this.open = true;
        return this.assistant([{ type: "toolCall", id: event.callId, name: event.name, arguments: args }]);
      }
      case "tool/result": return this.result(event);
      case "turn/end": return this.turnEnd(event.reason, prev, next);
      default: return undefined;
    }
  }

  message(event, prev, next) {
    if (event.usage) this.usage = addUsage(this.usage, deltaUsage(prev, next));
    const parts = (event.message?.content ?? []).filter((b) => b?.type === "text" && b.text.trim()).map((b) => ({ type: "text", text: b.text }));
    if (parts.length) this.assistant(parts);
  }

  result(event) {
    const callId = event.message?.toolCallId;
    const failed = event.message?.isError === true || event.error !== undefined;
    let text = textOf(event.message?.content);
    if (failed && !text) text = String(event.error?.reason ?? event.error?.name ?? "tool failed");
    this.row({ role: "toolResult", toolCallId: callId, toolName: this.names.get(callId) ?? "tool", isError: failed, content: [{ type: "text", text }] });
  }

  turnEnd(reason, prev, next) {
    this.settleTools(prev, next);
    const kind = reason?.kind;
    if (kind === "error") this.stop("error", String(reason.error?.message ?? reason.error?.code ?? "model error"));
    else if (kind === "aborted") this.stop("aborted");
    else this.stop("stop");
  }

  /** The turn was cut short (cancel, crash, failed send): close the open turn if there is one. */
  interrupted(prev, next, stopReason, errorMessage) {
    if (!this.open) return;
    this.settleTools(prev, next);
    this.stop(stopReason, errorMessage);
  }

  /** A call the reducer marked interrupted gets an error result, so the host never shows it pending. */
  settleTools(prev, next) {
    const after = new Map(next.blocks.filter((b) => b.kind === "tool").map((b) => [b.callId, b]));
    for (const block of prev.blocks) {
      if (block.kind !== "tool" || block.status !== "pending") continue;
      const settled = after.get(block.callId);
      if (settled?.status !== "error" || settled.error?.code !== "INTERRUPTED") continue;
      this.row({ role: "toolResult", toolCallId: block.callId, toolName: block.name, isError: true, content: [{ type: "text", text: "Interrupted" }] });
    }
  }
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return text; }
}

/** Token and cost increase the reducer folded for one request, in Pi's usage shape (cost only when priced). */
function deltaUsage(prev, next) {
  const d = (key) => num(next.usage[key]) - num(prev.usage[key]);
  const usage = { input: d("input"), output: d("output"), cacheRead: d("cacheRead"), cacheWrite: d("cacheWrite") };
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  if (next.price) usage.cost = { total: Number(d("cost").toFixed(10)) };
  return usage;
}

function addUsage(a, b) {
  if (!a) return b;
  const sum = { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, totalTokens: a.totalTokens + b.totalTokens };
  if (a.cost || b.cost) sum.cost = { total: Number(((a.cost?.total ?? 0) + (b.cost?.total ?? 0)).toFixed(10)) };
  return sum;
}
