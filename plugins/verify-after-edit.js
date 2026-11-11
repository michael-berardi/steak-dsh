/**
 * Verify after edit for DeepSeek Harness.
 *
 * After a successful file edit, run the project's check command and hand the result straight back to the model
 * with the edit result, so a broken edit is fixed in the same turn instead of being reported as done.
 *
 * The command comes only from places the user controls:
 *   1. this row's `command` config, or
 *   2. `$DSH_HOME/steak-dsh.json`: { "projects": { "/abs/project": { "verify": { "command": "npm test" } } } }, or
 *   3. `<project>/.steak-dsh/config.json` ({ "verify": { "command": ... } }), honoured only when the project path is
 *      listed in `trusted` in `$DSH_HOME/steak-dsh.json`. A cloned repository cannot make the harness run a command.
 * No command configured means this plugin does nothing.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const name = "steak-verify-after-edit";
export const inject = ["tools"];

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "str_replace_editor"]);
const OUTPUT_TAIL = 4000;

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

export const dshHome = () => {
  const configured = (process.env.DSH_HOME ?? "").trim();
  return configured ? configured : join(homedir(), ".dsh");
};

const positiveInt = (value, fallback, max) => (Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback);

/** Resolve the verify settings for one project directory, or undefined when nothing is configured. */
export function verifySettings(projectDir, rowConfig = {}, home = dshHome()) {
  const homeFile = readJson(join(home, "steak-dsh.json")) ?? {};
  const dir = resolve(projectDir);
  let raw;
  if (typeof rowConfig.command === "string" && rowConfig.command.trim()) raw = rowConfig;
  if (!raw) raw = homeFile.projects?.[dir]?.verify;
  if (!raw && Array.isArray(homeFile.trusted) && homeFile.trusted.map((p) => resolve(String(p))).includes(dir)) {
    raw = readJson(join(dir, ".steak-dsh", "config.json"))?.verify;
  }
  if (!raw || typeof raw.command !== "string" || !raw.command.trim()) return undefined;
  return {
    command: raw.command.trim(),
    failLimit: positiveInt(raw.failLimit, 2, 10),
    timeoutMs: positiveInt(raw.timeoutMs, 90_000, 600_000),
  };
}

/** Run the command in its own process group; resolve with exit code, tail of output and duration. Never rejects.
 * Settles when the bash process EXITS (a background job holding the pipes open cannot stall it): after exit,
 * remaining output gets at most 200 ms, then the streams are destroyed. A timeout SIGTERMs then SIGKILLs the
 * group and still resolves within 1 s even if `close` never fires. */
export function runCommand(command, cwd, timeoutMs, signal) {
  return new Promise((done) => {
    const started = Date.now();
    let output = "";
    let timedOut = false;
    let settled = false;
    let closed = false;
    let child;
    try {
      child = spawn("/bin/bash", ["--noprofile", "--norc", "-o", "pipefail", "-c", command], {
        cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, BASH_ENV: "", ENV: "" },
      });
    } catch (error) {
      done({ code: -1, output: `could not start: ${error?.message ?? error}`, ms: 0, timedOut: false });
      return;
    }
    const keep = (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > OUTPUT_TAIL * 4) output = output.slice(-OUTPUT_TAIL * 2);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const kill = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch { /* already gone */ }
    };
    let killTimer, graceTimer, hardTimer;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(graceTimer);
      clearTimeout(hardTimer);
      signal?.removeEventListener("abort", stop);
      if (!closed) kill("SIGKILL"); // no stray group members outlive the settled run
      try { child.stdout.destroy(); } catch { /* already destroyed */ }
      try { child.stderr.destroy(); } catch { /* already destroyed */ }
      done({ code, output: output.slice(-OUTPUT_TAIL), ms: Date.now() - started, timedOut });
    };
    const stop = () => {
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 250);
      hardTimer = setTimeout(() => finish(-1), 900); // resolve even if neither exit nor close ever fires
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => {
      output = `could not start: ${error.message}`;
      finish(-1);
    });
    child.on("exit", (code) => {
      graceTimer = setTimeout(() => finish(code ?? -1), 200); // at most 200 ms for output still in the pipes
    });
    child.on("close", (code) => {
      closed = true;
      finish(code ?? -1);
    });
  });
}

export function failureText(settings, attempt, result) {
  const why = result.timedOut ? `timed out after ${settings.timeoutMs} ms` : `exit code ${result.code}`;
  const tail = attempt >= settings.failLimit
    ? "Verification is paused until your next request."
    : "Fix the reported problem before finishing.";
  return `[steak-dsh] verify failed (attempt ${attempt}/${settings.failLimit}, ${why}): ${settings.command}\n${result.output.trim()}\n${tail}`;
}

const notice = (text, summary) => Object.freeze({
  role: "user",
  content: [{ type: "text", text }],
  source: { kind: name, form: "notice", summary: summary.slice(0, 120) },
  id: randomUUID(),
});

export function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  const states = new WeakMap(); // agent -> { generation, fails, chain, turn }
  const turns = new WeakMap(); // agent -> the last turn number seen on agent/pre-step
  // A new turn clears the fail limit: verification pauses for the rest of the failing turn only.
  // Waterfall listener: must return next() unchanged. A harness without this event must still load the plugin.
  try {
    ctx.on("agent/pre-step", (payload, next) => {
      const agent = payload?.agent;
      if (agent) {
        const state = states.get(agent);
        if (state) {
          if (state.turn !== undefined && payload.turn !== state.turn) state.fails = 0;
          state.turn = payload.turn;
        }
        turns.set(agent, payload.turn);
      }
      return next();
    });
  } catch { /* harness without agent/pre-step: the fail limit then lasts for the session */ }
  const cwdOf = (agent) => {
    try {
      const dir = ctx.get?.("workingDirectory")?.get(agent.session);
      if (typeof dir === "string" && isAbsolute(dir)) return dir;
    } catch { /* fall through to the launch directory */ }
    return process.cwd();
  };
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    if (!EDIT_TOOLS.has(exec.name) || result.isError || decision.kind !== "accept" || !exec.agent || exec.signal.aborted) return decision;
    const project = cwdOf(exec.agent);
    const settings = verifySettings(project, config);
    if (!settings) return decision;
    let state = states.get(exec.agent);
    if (!state) states.set(exec.agent, state = { generation: 0, fails: 0, chain: Promise.resolve(), turn: turns.get(exec.agent) });
    if (state.fails >= settings.failLimit) return decision;
    const mine = state.generation += 1;
    // Edits made in one batch share one run: only the latest edit runs the command.
    const run = state.chain.then(async () => {
      await new Promise((r) => setTimeout(r, 150));
      if (mine !== state.generation || exec.signal.aborted) return undefined;
      return runCommand(settings.command, project, settings.timeoutMs, exec.signal);
    });
    state.chain = run.then(() => undefined, () => undefined);
    const outcome = await run;
    // A run cut short by an abort is not a failure: leave the decision unchanged and do not count it.
    if (!outcome || exec.signal.aborted) return decision;
    let text, summary;
    if (outcome.code === 0 && !outcome.timedOut) {
      state.fails = 0;
      text = `[steak-dsh] verify passed: ${settings.command} | ${outcome.ms}ms`;
      summary = "verify passed";
    } else {
      state.fails += 1;
      text = failureText(settings, state.fails, outcome);
      summary = `verify failed ${state.fails}/${settings.failLimit}`;
    }
    return { ...decision, additionalContexts: [...decision.additionalContexts ?? [], notice(text, summary)] };
  });
}
