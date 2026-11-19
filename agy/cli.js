/**
 * Running Google's official Antigravity CLI (`agy`) the way Google documents for scripting: `agy models` for the list,
 * `agy --input-format stream-json --output-format stream-json` (prompt on stdin, never argv) for a run. agy keeps its own tools, permissions and sign-in; this file
 * only starts it, reads its documented NDJSON and stops it. It never passes --dangerously-skip-permissions.
 */
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { AgyError, CODES, cleanAgyText, INSTALL_COMMAND, MISSING_MESSAGE, SIGN_IN_HINT } from "./errors.js";

/** Bounded stop: SIGINT first, then SIGTERM, then SIGKILL, each to the whole process group. */
export const STOP_STEPS_MS = Object.freeze({ interrupt: 3_000, terminate: 2_000 });
const AUTH_GRACE_MS = 1_500;
const TAIL_BYTES = 16_384;
const SIGNED_OUT_STDERR = /Authentication required/i;
const AUTH_TEXT = /authenticat|sign[ -]?in|signed in|log ?in\b|unauthenticated|credential/i;
const NOTICE = /\b(denied|permission|allow)\b/i;
const DRAIN_MS = 500;


export const configuredCommand = (env) => (env.STEAK_DSH_AGY_BIN && env.STEAK_DSH_AGY_BIN.trim()) || "agy";

async function executable(path) {
  try { await access(path, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK); return true; } catch { return false; }
}

/** The agy executable (STEAK_DSH_AGY_BIN, else `agy` on PATH), or a named AGY_MISSING error. */
export async function resolveAgy(env = process.env) {
  const command = configuredCommand(env);
  const explicit = Boolean(env.STEAK_DSH_AGY_BIN && env.STEAK_DSH_AGY_BIN.trim());
  if (isAbsolute(command) || command.includes("/")) {
    const candidate = resolve(command);
    if (await executable(candidate)) return candidate;
    throw new AgyError(`${explicit ? `STEAK_DSH_AGY_BIN points at "${command}", which is not an executable file. ` : ""}${MISSING_MESSAGE}`, CODES.MISSING);
  }
  for (const directory of (env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    if (await executable(candidate)) return candidate;
  }
  throw new AgyError(MISSING_MESSAGE, CODES.MISSING);
}

const tail = (text, chunk) => (text + chunk).slice(-TAIL_BYTES);

export function notSignedIn(cause) {
  const text = cleanAgyText(cause).trim().replace(/\s+/g, " ");
  return new AgyError(`agy is not signed in${text ? `: ${text}` : ""}; ${SIGN_IN_HINT}`, CODES.NOT_SIGNED_IN);
}

/** Stop the child's process group: SIGINT, then SIGTERM, then SIGKILL, with bounded waits. Resolves once the leader exited. */
export function stopGroup(child, steps = STOP_STEPS_MS) {
  return new Promise((done) => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) { done(); return; }
    const send = (signal) => {
      try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
    };
    const timers = [];
    child.once("exit", () => { for (const timer of timers) clearTimeout(timer); done(); });
    send("SIGINT");
    timers.push(setTimeout(() => {
      send("SIGTERM");
      timers.push(setTimeout(() => send("SIGKILL"), steps.terminate));
    }, steps.interrupt));
  });
}

/** agy children still running: each leads its own process group, so it would outlive steak-dsh unless killed here. */
const live = new Set();
let guarded = false;
/** A steak-dsh that exits, or is hung up or terminated, takes the agy groups it started with it. */
function guardExit() {
  if (guarded) return;
  guarded = true;
  process.on("exit", () => { for (const child of live) killGroup(child); });
  for (const signal of ["SIGHUP", "SIGTERM"]) {
    const onSignal = () => {
      for (const child of live) killGroup(child);
      // Only listener: leave and re-raise, so the process ends the way the signal asked. Otherwise others decide.
      if (process.listenerCount(signal) === 1) { process.removeListener(signal, onSignal); process.kill(process.pid, signal); }
    };
    process.on(signal, onSignal);
  }
}

function spawnAgy(command, args, { cwd, env }) {
  guardExit();
  const child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  live.add(child);
  child.once("exit", () => live.delete(child));
  child.once("error", () => live.delete(child));
  return child;
}

/** SIGKILL the child's whole process group (tool processes agy started); an empty group (ESRCH) is fine. */
export function killGroup(child) {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already empty */ }
}

/** After agy's exit: kill leftover group members, give the pipes a moment to drain, then destroy them. */
function reap(child) {
  killGroup(child);
  return new Promise((done) => {
    const pipes = [child.stdout, child.stderr].filter((p) => p && !p.destroyed && !p.readableEnded);
    const finish = () => { clearTimeout(timer); for (const p of [child.stdin, child.stdout, child.stderr]) p?.destroy(); done(); };
    const timer = setTimeout(finish, DRAIN_MS);
    let open = pipes.length;
    if (!open) { finish(); return; }
    for (const p of pipes) p.once("close", () => { if (--open === 0) finish(); });
  });
}

/** The one stream-json line agy reads from stdin for a prompt. */
export const promptLine = (prompt) => `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;

/** Run `agy <args>` to the end and capture it (used for `agy models`). */
async function capture(env, args, { signal, timeoutMs = 30_000 } = {}) {
  const command = await resolveAgy(env);
  signal?.throwIfAborted();
  const child = spawnAgy(command, args, { cwd: undefined, env });
  child.stdin.on("error", () => {});
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => { stdout = tail(stdout, c); });
  child.stderr.on("data", (c) => { stderr = tail(stderr, c); });
  let reason;
  const stop = (why) => { reason ??= why; void stopGroup(child); };
  const timer = setTimeout(() => stop("timeout"), timeoutMs);
  const onAbort = () => stop("abort");
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const code = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (c) => { void reap(child).then(() => resolveExit(c)); });
    });
    if (reason === "timeout") throw new AgyError(`agy ${args.join(" ")} timed out after ${timeoutMs} ms`, CODES.TIMEOUT);
    if (reason === "abort") throw new AgyError(`agy ${args.join(" ")} was cancelled`, CODES.CANCELLED);
    return { code, stdout, stderr };
  } catch (error) {
    if (error instanceof AgyError) throw error;
    if (error?.code === "ENOENT" || error?.code === "EACCES") throw new AgyError(MISSING_MESSAGE, CODES.MISSING, { cause: error });
    throw new AgyError(`could not start agy (${command}): ${error?.message ?? error}`, CODES.FAILED, { cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (child.exitCode === null && child.signalCode === null) await stopGroup(child);
  }
}

/** One non-empty line of `agy models` -> { id, name }, or undefined for anything that is not a `<slug> <name>` row. */
export function parseModelLine(line) {
  const match = /^\s*([A-Za-z0-9][A-Za-z0-9_.:-]*)\s+(\S.*?)\s*$/.exec(line);
  if (!match || /^(fetching|available|error|warning)\b/i.test(line.trim())) return undefined;
  return { id: match[1], name: match[2] };
}

/** The plan's models from `agy models`. A signed-out or failing agy is a named error carrying agy's own words. */
export async function listAgyModels(env = process.env, options = {}) {
  const { code, stdout, stderr } = await capture(env, ["models"], options);
  const said = `${stderr}\n${stdout}`.split("\n").map((l) => l.trim()).filter((l) => l && !/^fetching available models/i.test(l));
  if (code !== 0) {
    const line = said.find((l) => /^error:/i.test(l)) ?? said.at(-1) ?? `exited ${code}`;
    if (AUTH_TEXT.test(line)) throw notSignedIn(line.replace(/^error:\s*/i, ""));
    throw new AgyError(`agy models failed (exit ${code}): ${cleanAgyText(line.replace(/^error:\s*/i, ""))}`, CODES.FAILED);
  }
  const rows = [];
  const seen = new Set();
  for (const line of stdout.split("\n")) {
    const row = parseModelLine(line);
    if (row && !seen.has(row.id)) { seen.add(row.id); rows.push(row); }
  }
  if (rows.length === 0) throw new AgyError("agy models listed no models for this account (the plan offers none, or the output was not `<slug> <name>` rows)", CODES.FAILED);
  return rows;
}

/** Installed? signed in? For `steak-dsh doctor`. Never throws. */
export async function agyStatus(env = process.env, options = {}) {
  let path;
  try { path = await resolveAgy(env); } catch (error) { return { available: false, detail: error.message }; }
  try {
    const rows = await listAgyModels(env, options);
    return { available: true, path, signedIn: true, models: rows.length };
  } catch (error) {
    if (error.code === CODES.NOT_SIGNED_IN) return { available: true, path, signedIn: false, detail: error.message };
    return { available: true, path, signedIn: undefined, detail: error.message };
  }
}

/**
 * One headless agy run: `input` (the prompt) goes to stdin as one stream-json user event, then stdin is closed. Resolves { result, stderr } with agy's terminal `result` object; rejects with a named AgyError.
 * `onEvent` gets every parsed NDJSON event; `onNotice` gets stderr lines that look like permission notices.
 * The returned promise settles only after the process group has exited.
 */
export function runAgy({ command, args, input, cwd, env, signal, timeoutMs, onEvent, onNotice }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try { signal?.throwIfAborted(); child = spawnAgy(command, args, { cwd, env }); } catch (error) { rejectPromise(error); return; }
    let result;
    let stderr = "";
    let stray = "";
    let failure;
    let stopping;
    let authTimer;
    const fail = (error) => {
      failure ??= error;
      stopping ??= stopGroup(child);
    };
    const timer = timeoutMs ? setTimeout(() => fail(new AgyError(`agy produced no final result within ${timeoutMs} ms; it was stopped`, CODES.TIMEOUT)), timeoutMs) : undefined;
    const onAbort = () => fail(new AgyError("agy run cancelled", CODES.CANCELLED));
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdin.on("error", () => { /* agy left before reading the prompt; its exit explains why */ });
    child.stdin.end(promptLine(input ?? ""));
    child.on("error", (error) => {
      fail(error?.code === "ENOENT" || error?.code === "EACCES"
        ? new AgyError(MISSING_MESSAGE, CODES.MISSING, { cause: error })
        : new AgyError(`could not start agy (${command}): ${error?.message ?? error}`, CODES.FAILED, { cause: error }));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = tail(stderr, chunk);
      // Signed out, agy waits a minute for a browser sign-in nobody can do here. Stop at once and say so.
      // It gets a moment to write its own result and leave first, so its own words can be the cause shown.
      if (!failure && !authTimer && SIGNED_OUT_STDERR.test(stderr)) authTimer = setTimeout(() => fail(notSignedIn("agy said \"Authentication required\"")), AUTH_GRACE_MS);
      for (const line of chunk.split("\n")) if (NOTICE.test(line) && line.trim()) onNotice?.(cleanAgyText(line).trim());
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { stray = tail(stray, `${line}\n`); return; }
      if (event?.event === "result" && event.result && typeof event.result === "object") result = event.result;
      try { onEvent?.(event); } catch (error) { fail(error); }
    });
    let finalized = false;
    const finalize = (code, killedBy) => {
      if (finalized) return;
      finalized = true;
      clearTimeout(timer);
      clearTimeout(authTimer);
      signal?.removeEventListener("abort", onAbort);
      // Always (success too): nothing agy started may outlive it, and a grandchild holding stdout must not hang us.
      void Promise.all([reap(child), stopping]).then(() => {
        if (failure) {
          // Stopped while signed out: agy's own result text, when it got to write one, is the cause to show.
          rejectPromise(failure.code === CODES.NOT_SIGNED_IN && result?.error ? notSignedIn(result.error) : failure);
          return;
        }
        if (result) { resolvePromise({ result, stderr, exitCode: code }); return; }
        const said = cleanAgyText(`${stderr}\n${stray}`).trim().split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
        if (AUTH_TEXT.test(stderr)) { rejectPromise(notSignedIn(said)); return; }
        rejectPromise(new AgyError(`agy exited ${killedBy ? `from ${killedBy}` : `with code ${code}`} without a result event${said ? `: ${said}` : ""}`, CODES.FAILED));
      });
    };
    child.on("exit", finalize);
    child.on("error", () => { if (child.pid === undefined) finalize(null, null); }); // never started: no exit event will come
  });
}

export { AUTH_TEXT, INSTALL_COMMAND, cleanAgyText };
