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
 * Safety: the id must be a canonical lowercase uuid and the file exactly `<id>.jsonl`. The folder must already exist
 * (or is created as one 0700 folder whose parent exists) and be ours and not group/world writable. The file is created
 * at start with an exclusive, no-follow create and 0600: an existing file is refused, never replaced. Only /new and
 * /resume replace the file, atomically, and only a file this process created that is still at the path (a refused
 * start never publishes later, and a foreign file found there is left alone). Every append opens the path without following a symlink and checks with fstat
 * that it is still the file this process created (device and inode); otherwise publishing stops. Any write error
 * stops publishing with one notice and one last row saying so; it never reaches the conversation. Each published
 * text field is cut at MAX_TEXT UTF-16 code units, never inside a character, and a row over MAX_ROW bytes is published
 * with its texts and tool arguments replaced by a marker. A short write is rolled back so no partial line stays.
 */
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute } from "node:path";
import { flattenEvent } from "./state.js";

export const ENV_FILE = "ULTRATERM_UI_TRANSCRIPT_FILE";
export const ENV_SESSION = "ULTRATERM_UI_SESSION_ID";
export const ENV_MAIN_SCREEN = "ULTRATERM_MAIN_SCREEN";

export const MAX_TEXT = 262144;
export const TRUNCATED = "\n[truncated]";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_ROW = 4 * 1024 * 1024; // bytes of one line; a host reader refuses a far larger one
const MARKER = TRUNCATED.trim();
const wellFormed = (text) => (typeof text.toWellFormed === "function" ? text.toWellFormed() : text);
const highSurrogate = (unit) => unit >= 0xd800 && unit <= 0xdbff;
/** Cut at MAX_TEXT code units, one less when that would split a character; a lone surrogate never reaches the file. */
const cap = (text) => {
  if (typeof text !== "string") return text;
  if (text.length <= MAX_TEXT) return wellFormed(text);
  const end = highSurrogate(text.charCodeAt(MAX_TEXT - 1)) ? MAX_TEXT - 1 : MAX_TEXT;
  return wellFormed(text.slice(0, end)) + TRUNCATED;
};
/** The same message with every text and every tool argument replaced by the marker. */
const slim = (message) => ({
  ...message,
  content: (message.content ?? []).map((part) => (part?.type === "toolCall" ? { ...part, arguments: { input: MARKER } } : part?.type === "text" ? { ...part, text: MARKER } : part)),
  ...(typeof message.errorMessage === "string" ? { errorMessage: MARKER } : {}),
});
const capDeep = (value) => {
  if (typeof value === "string") return cap(value);
  if (Array.isArray(value)) return value.map(capDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capDeep(v)]));
  return value;
};
const STOPPED_SENTENCE = "Publishing of this conversation to the host stopped; later messages are not shown here.";

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
    this.write = writeSync; // replaced by the tests to make a write fail part-way
    this.resetRows();
  }

  /** Write all of `text`; a write that stores nothing is an error. */
  writeAll(fd, text) {
    const bytes = Buffer.from(text, "utf8");
    let done = 0;
    while (done < bytes.length) {
      const wrote = this.write(fd, bytes, done, bytes.length - done);
      if (!(wrote > 0)) { const error = new Error("short write"); error.code = "ESHORT"; throw error; }
      done += wrote;
    }
  }

  resetRows() {
    this.count = 0;
    this.last = null;
    this.open = false; // a user row was published and no stop row has closed the turn yet
    this.usage = undefined; // usage of a message that had no row of its own yet
    this.names = new Map(); // callId -> tool name
  }

  /** Validate the target and create the file holding only the header. Returns true when publishing is on; otherwise a notice says why. */
  start(onNotice = () => {}) {
    this.onNotice = onNotice;
    const problem = this.check();
    if (problem) { onNotice(`transcript not published to the host: ${problem}`); return false; }
    try {
      this.createExclusive();
    } catch (error) {
      onNotice(`transcript not published to the host: ${error?.code === "EEXIST" ? "the transcript file already exists" : `could not create the transcript (${cause(error)})`}`);
      return false;
    }
    this.active = true;
    return true;
  }

  /** The folder and name rules; true-or-message. The file itself is judged by the exclusive create. */
  check() {
    const { file, id } = this;
    if (!file || !id) return `both ${ENV_FILE} and ${ENV_SESSION} are needed`;
    if (!isAbsolute(file)) return `${ENV_FILE} is not an absolute path`;
    if (!UUID.test(id)) return `${ENV_SESSION} is not a lowercase uuid`;
    if (basename(file) !== `${id}.jsonl`) return `${ENV_FILE} does not end in the session id`;
    const uid = process.getuid?.();
    const dir = dirname(file);
    const bad = (st, what) => {
      if (!st.isDirectory()) return `${what} is not a folder`;
      if (uid !== undefined && st.uid !== uid) return `${what} is not owned by you`;
      if ((st.mode & 0o022) !== 0) return `${what} is group or world writable`;
      return undefined;
    };
    try {
      let st = lstatSync(dir, { throwIfNoEntry: false });
      if (!st) {
        const parent = lstatSync(dirname(dir), { throwIfNoEntry: false });
        if (!parent) return "the transcript folder's parent does not exist";
        const why = bad(parent, "the parent of the transcript folder");
        if (why) return why;
        mkdirSync(dir, { mode: 0o700 });
        st = lstatSync(dir);
      }
      const why = bad(st, "the transcript folder");
      if (why) return why;
    } catch (error) {
      return `the transcript folder could not be used (${cause(error)})`;
    }
    return undefined;
  }

  header() {
    return `${JSON.stringify({ type: "session", version: 3, id: this.id, cwd: this.cwd })}\n`;
  }

  remember(fd) {
    const st = fstatSync(fd);
    this.identity = { dev: st.dev, ino: st.ino };
  }

  /** First creation: exclusive and no-follow; an existing file (even a symlink) makes it throw EEXIST. */
  createExclusive() {
    this.resetRows();
    const fd = openSync(this.file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    let made;
    try {
      made = fstatSync(fd);
      fchmodSync(fd, 0o600);
      this.writeAll(fd, this.header());
      fsyncSync(fd);
      this.remember(fd);
    } catch (error) {
      // The file this call just made must not stay behind empty or half-written: remove it, if it is still the one at the path.
      try {
        const now = lstatSync(this.file, { throwIfNoEntry: false });
        if (made && now && now.dev === made.dev && now.ino === made.ino) unlinkSync(this.file);
      } catch { /* left as it is; the host reports a file it cannot read */ }
      throw error;
    } finally {
      closeSync(fd);
    }
  }

  tmpSuffix() {
    return randomBytes(8).toString("hex");
  }

  /** Atomically put a file holding only the header at the path: random-named temp file beside it, fsync, rename. */
  replace() {
    const tmp = `${this.file}.${this.tmpSuffix()}.tmp`;
    let fd;
    let created = false;
    try {
      fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      created = true;
      fchmodSync(fd, 0o600);
      this.writeAll(fd, this.header());
      fsyncSync(fd);
      const st = fstatSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, this.file);
      this.identity = { dev: st.dev, ino: st.ino };
      this.resetRows(); // only now: a failed replace keeps the old file's row chain for its final row
    } catch (error) {
      if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
      if (created) try { unlinkSync(tmp); } catch { /* already gone */ }
      throw error;
    }
  }

  /**
   * A /new or /resume: replace the file; this also resumes publishing after an earlier stop. Only for a file this
   * process created: a publisher whose start was refused (the file existed, a bad folder) never publishes, and a
   * foreign file now at the path is not replaced.
   */
  restart() {
    if (!this.identity) return;
    const problem = this.check();
    if (problem) {
      // The folder stopped being private: stop with a notice instead of appending the new conversation to the old file.
      if (this.active) this.fail(new Error(problem));
      return;
    }
    const now = lstatSync(this.file, { throwIfNoEntry: false });
    if (now && (now.dev !== this.identity.dev || now.ino !== this.identity.ino)) return;
    try {
      this.replace();
      this.active = true;
    } catch (error) {
      if (this.active) this.fail(error);
    }
  }

  fail(error, { foreign = false } = {}) {
    if (!this.active) return;
    this.active = false;
    if (!foreign) {
      try { this.append(this.entry({ role: "assistant", content: [{ type: "text", text: STOPPED_SENTENCE }], stopReason: "error" }, this.count + 1)); } catch { /* the file is not writable: nothing more to do */ }
    }
    this.onNotice(`transcript publishing stopped (${cause(error)}); the session itself is unaffected`);
  }

  entry(message, n, extra = {}) {
    const ms = this.now();
    const id = n.toString(16).padStart(8, "0");
    return { type: "message", id, parentId: this.last, timestamp: new Date(ms).toISOString(), message: { ...message, timestamp: ms }, ...extra };
  }

  /** One complete line in one write, to the file this process created: checked by fstat on the opened descriptor. */
  append(entry) {
    const fd = openSync(this.file, constants.O_WRONLY | constants.O_APPEND | NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!this.identity || st.dev !== this.identity.dev || st.ino !== this.identity.ino) {
        const error = new Error("the transcript file was replaced");
        error.code = "REPLACED";
        throw error;
      }
      try {
        this.writeAll(fd, `${JSON.stringify(entry)}\n`);
      } catch (error) {
        try { ftruncateSync(fd, st.size); } catch { /* the partial line stays; publishing stops either way */ }
        throw error;
      }
    } finally {
      closeSync(fd);
    }
  }

  /** Append one row; the counter and the chain only advance once the line is written. */
  row(message, extra = {}) {
    let entry = this.entry(message, this.count + 1, extra);
    if (Buffer.byteLength(JSON.stringify(entry), "utf8") > MAX_ROW) entry = { ...entry, message: { ...slim(entry.message), timestamp: entry.message.timestamp } };
    this.append(entry);
    this.count += 1;
    this.last = entry.id;
  }

  assistant(content, extra = {}) {
    const message = { role: "assistant", content, ...extra };
    if (this.usage) { message.usage = this.usage; this.usage = undefined; }
    this.row(message);
  }

  userRow(text) {
    this.row({ role: "user", content: [{ type: "text", text: cap(text) }] });
    this.open = true;
  }

  /** The assistant row that ends a turn, after closing any tool call that never got a result. */
  stop(stopReason, errorMessage) {
    this.assistant([], errorMessage === undefined ? { stopReason } : { stopReason, errorMessage: cap(errorMessage) });
    this.open = false;
  }

  /** The note a resumed session starts with (a fresh file; earlier messages are not replayed on the SDK wire). */
  note(text) {
    if (!this.active) return;
    try {
      this.assistant([{ type: "text", text }], { stopReason: "stop" });
    } catch (error) {
      this.fail(error, { foreign: error?.code === "REPLACED" || error?.code === "ENOENT" || error?.code === "ELOOP" });
    }
  }

  /**
   * Called by the controller after every dispatched action with the state before and after.
   * Never throws: a failure here stops publishing and nothing else.
   */
  observe(action, prev, next) {
    if (!this.active) {
      if (action.type === "newSession") this.restart();
      return;
    }
    try {
      this.publish(action, prev, next);
    } catch (error) {
      this.fail(error, { foreign: error?.code === "REPLACED" || error?.code === "ENOENT" || error?.code === "ELOOP" });
    }
  }

  publish(action, prev, next) {
    switch (action.type) {
      case "submit": return this.userRow(action.text);
      case "command": return this.userRow(action.text);
      case "newSession": return this.restart();
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
      if (text) this.assistant([{ type: "text", text: cap(text) }]);
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
        const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { input: raw };
        const args = capDeep(typeof base.file_path === "string" ? { ...base, path: base.file_path } : base);
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
    const parts = (event.message?.content ?? []).filter((b) => b?.type === "text" && b.text.trim()).map((b) => ({ type: "text", text: cap(b.text) }));
    if (parts.length) this.assistant(parts);
  }

  result(event) {
    const callId = event.message?.toolCallId;
    const failed = event.message?.isError === true || event.error !== undefined;
    let text = textOf(event.message?.content);
    if (failed && !text) text = String(event.error?.reason ?? event.error?.name ?? "tool failed");
    this.row({ role: "toolResult", toolCallId: callId, toolName: this.names.get(callId) ?? "tool", isError: failed, content: [{ type: "text", text: cap(text) }] });
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
