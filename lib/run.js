/**
 * `steak-dsh run`: one headless dsh run with the overlays applied; exit with dsh's exit code.
 *
 * When `--json` and `--idle-timeout <sec>` (or `STEAK_DSH_IDLE_TIMEOUT_SEC`) are active, monitors the NDJSON
 * stdout stream for stalls, pausing the timer while any `tool_call` awaits its matching `tool_result` or while
 * downstream stdout applies backpressure. On idle expiry, terminates the child process group (SIGTERM -> grace
 * SIGKILL within a bounded grace period), emits a clear final `stalled-stream` error on both stdout JSON and
 * stderr, and exits non-zero (124).
 */
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { launchEnv } from "./dsh.js";
import { headlessArgs, overlayFiles } from "./overlay.js";

export const IDLE_TIMEOUT_EXIT_CODE = 124;
export const DEFAULT_IDLE_KILL_GRACE_MS = 2_000;

function groupAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Write `data` to `stream` and wait for it to flush when `stream` is a Node Writable. */
function writeFlushed(stream, data) {
  if (typeof stream?.on !== "function") {
    if (data) stream.write(data);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    stream.once("error", finish);
    try {
      stream.write(data, () => {
        stream.removeListener("error", finish);
        finish();
      });
    } catch {
      stream.removeListener("error", finish);
      finish();
    }
  });
}

export async function runCommand(o, task, {
  root,
  bin,
  killGraceMs = DEFAULT_IDLE_KILL_GRACE_MS,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const { files, cleanup } = overlayFiles(o, root);
  const onExit = () => cleanup();
  process.once("exit", onExit);
  const args = headlessArgs(o, files, task);
  const watchIdle = Boolean(o.json && Number.isFinite(o.idleTimeoutSec) && o.idleTimeoutSec > 0);
  try {
    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(bin, args, {
          stdio: watchIdle ? ["inherit", "pipe", "inherit"] : "inherit",
          env: launchEnv(),
          detached: true,
        });
      } catch (error) {
        reject(new Error(`could not start dsh (${bin}): ${error.message}`));
        return;
      }

      // The child runs in its own process group so a terminal Ctrl-C reaches it only through us,
      // and idle-timeout / pipe-error cleanup terminates dsh and its process group cleanly.
      const signalGroup = (signal) => {
        if (!child?.pid) return;
        try { process.kill(-child.pid, signal); }
        catch { try { child.kill(signal); } catch { /* already gone */ } }
      };
      const handlers = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"].map((signal) => {
        const handler = () => signalGroup(signal);
        process.on(signal, handler);
        return [signal, handler];
      });

      let settled = false;
      let idleTimer;
      let killTimer;
      let exitDrainTimer;
      let exitKillTimer;
      let groupPoll;
      let drainHandler;
      let stdoutErrorHandler;
      let stdoutPaused = false;
      let timedOut = false;
      let brokenPipe = false;
      let exitCleanupActive = false;
      let pipeErrorCode;
      let timeoutDeadline = 0;
      let childExited = false;
      let exitCode;
      let exitSignal;
      let endedWithNewline = true;
      let sessionId = o.sessionId;
      const openToolCalls = new Set();
      let anonymousOpenTools = 0;

      const clearIdle = () => {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
      };

      const clearDrain = () => {
        if (drainHandler && typeof stdout?.removeListener === "function") {
          stdout.removeListener("drain", drainHandler);
          drainHandler = undefined;
        }
        stdoutPaused = false;
      };

      const clearTimers = () => {
        clearIdle();
        if (killTimer) { clearTimeout(killTimer); killTimer = undefined; }
        if (exitDrainTimer) { clearTimeout(exitDrainTimer); exitDrainTimer = undefined; }
        if (exitKillTimer) { clearTimeout(exitKillTimer); exitKillTimer = undefined; }
        if (groupPoll) { clearInterval(groupPoll); groupPoll = undefined; }
      };

      const done = (finish) => {
        if (settled) return;
        settled = true;
        clearTimers();
        clearDrain();
        if (stdoutErrorHandler && typeof stdout?.removeListener === "function") {
          stdout.removeListener("error", stdoutErrorHandler);
          stdoutErrorHandler = undefined;
        }
        for (const [signal, handler] of handlers) process.removeListener(signal, handler);
        cleanup();
        finish();
      };

      const stopGroupWithGrace = () => {
        clearIdle();
        clearDrain();
        // Resume to discard remaining buffered pipe data so a paused stream never blocks close.
        try { child.stdout?.resume(); } catch { /* ignore */ }
        timeoutDeadline = Date.now() + killGraceMs;
        signalGroup("SIGTERM");
        if (!killTimer) {
          killTimer = setTimeout(() => {
            killTimer = undefined;
            signalGroup("SIGKILL");
            // Always destroy the pipe after SIGKILL so close completes even if a process outside the group holds it.
            try { child.stdout?.destroy(); } catch { /* ignore */ }
          }, killGraceMs);
        }
      };

      const scheduleExitCleanup = () => {
        if (!watchIdle || !childExited || timedOut || brokenPipe || settled || stdoutPaused || exitDrainTimer || exitKillTimer) return;
        const drainWaitMs = Math.min(killGraceMs, 250);
        exitDrainTimer = setTimeout(() => {
          exitDrainTimer = undefined;
          if (settled || timedOut || brokenPipe || stdoutPaused) return;
          exitCleanupActive = true;
          timeoutDeadline = Date.now() + killGraceMs;
          signalGroup("SIGTERM");
          exitKillTimer = setTimeout(() => {
            exitKillTimer = undefined;
            signalGroup("SIGKILL");
            try { child.stdout?.destroy(); } catch { /* ignore */ }
          }, killGraceMs);
        }, drainWaitMs);
      };

      const waitGroupThen = (after) => {
        const pid = child.pid;
        if (!groupAlive(pid)) {
          after();
          return;
        }
        let sigkilled = false;
        let postKillDeadline = 0;
        groupPoll = setInterval(() => {
          if (!groupAlive(pid)) {
            clearInterval(groupPoll);
            groupPoll = undefined;
            after();
            return;
          }
          const now = Date.now();
          if (!sigkilled && now >= timeoutDeadline) {
            sigkilled = true;
            signalGroup("SIGKILL");
            postKillDeadline = now + 250;
          } else if (sigkilled && now >= postKillDeadline) {
            clearInterval(groupPoll);
            groupPoll = undefined;
            after();
          }
        }, 25);
      };

      if (watchIdle) {
        const idleTimeoutMs = Math.max(1, Math.round(o.idleTimeoutSec * 1000));
        const decoder = new StringDecoder("utf8");
        let lineBuf = "";

        const isToolOpen = () => openToolCalls.size > 0 || anonymousOpenTools > 0;
        const armIdle = () => {
          clearIdle();
          if (timedOut || brokenPipe || childExited || settled || stdoutPaused || isToolOpen()) return;
          idleTimer = setTimeout(() => {
            if (timedOut || brokenPipe || childExited || settled || stdoutPaused) return;
            timedOut = true;
            stopGroupWithGrace();
          }, idleTimeoutMs);
        };

        const observeEvent = (event) => {
          if (!event || typeof event !== "object") return;
          if (typeof event.sessionId === "string" && event.sessionId) sessionId = event.sessionId;
          if (event.type === "tool_call") {
            const callId = event.callId ?? event.id ?? event.toolCallId;
            if (callId !== undefined && callId !== null && String(callId) !== "") openToolCalls.add(String(callId));
            else anonymousOpenTools += 1;
          } else if (event.type === "tool_result") {
            const callId = event.callId ?? event.id ?? event.toolCallId;
            if (callId !== undefined && callId !== null && openToolCalls.has(String(callId))) {
              openToolCalls.delete(String(callId));
            } else if (anonymousOpenTools > 0) {
              anonymousOpenTools -= 1;
            }
          } else if ((event.type === "status" && event.phase === "turn_end") || event.type === "final") {
            openToolCalls.clear();
            anonymousOpenTools = 0;
          }
        };

        if (typeof stdout?.on === "function") {
          stdoutErrorHandler = (error) => {
            if (brokenPipe || settled) return;
            brokenPipe = true;
            pipeErrorCode = error?.code;
            stopGroupWithGrace();
            try { child.stdout?.destroy(); } catch { /* ignore */ }
          };
          stdout.on("error", stdoutErrorHandler);
        }

        child.once("spawn", () => armIdle());
        child.stdout.on("error", () => {});
        child.stdout.on("data", (chunk) => {
          if (timedOut || brokenPipe) return;
          if (chunk.length > 0) {
            endedWithNewline = chunk[chunk.length - 1] === 0x0a;
            let ok = true;
            try {
              ok = stdout.write(chunk) !== false;
            } catch (error) {
              stdoutErrorHandler?.(error);
              return;
            }
            if (!ok && typeof stdout.once === "function") {
              stdoutPaused = true;
              clearIdle();
              // Cancel any pending after-exit cleanup so buffered output finishes draining to the slow reader.
              if (exitDrainTimer) { clearTimeout(exitDrainTimer); exitDrainTimer = undefined; }
              child.stdout.pause();
              if (!drainHandler) {
                drainHandler = () => {
                  drainHandler = undefined;
                  stdoutPaused = false;
                  if (settled || timedOut || brokenPipe) return;
                  child.stdout.resume();
                  if (childExited) scheduleExitCleanup();
                  else armIdle();
                };
                stdout.once("drain", drainHandler);
              }
            }
          }
          lineBuf += decoder.write(chunk);
          let nl;
          while ((nl = lineBuf.indexOf("\n")) >= 0) {
            const line = lineBuf.slice(0, nl).trim();
            lineBuf = lineBuf.slice(nl + 1);
            if (!line) continue;
            try { observeEvent(JSON.parse(line)); } catch { /* non-JSON stdout still resets the idle clock */ }
          }
          if (stdoutPaused || isToolOpen()) clearIdle();
          else armIdle();
        });
      }

      const emitStalledAndResolve = () => {
        const message = `steak-dsh: stalled-stream: no NDJSON output for ${o.idleTimeoutSec}s (idle timeout)`;
        const prefix = endedWithNewline ? "" : "\n";
        const errEvent = {
          type: "error",
          code: "stalled-stream",
          cause: "stalled-stream",
          message,
          idleTimeoutSec: o.idleTimeoutSec,
          ...(sessionId ? { sessionId } : {}),
        };
        const finalEvent = {
          type: "final",
          ...(sessionId ? { sessionId } : {}),
          reason: {
            kind: "error",
            cause: "stalled-stream",
            error: { code: "stalled-stream", message },
          },
          text: "",
        };
        const payload = `${prefix}${JSON.stringify(errEvent)}\n${JSON.stringify(finalEvent)}\n`;
        Promise.all([writeFlushed(stdout, payload), writeFlushed(stderr, message + "\n")]).then(() => {
          done(() => resolve(IDLE_TIMEOUT_EXIT_CODE));
        });
      };

      child.on("exit", (code, signal) => {
        childExited = true;
        exitCode = code;
        exitSignal = signal;
        if (!watchIdle || timedOut || brokenPipe) return;
        // dsh itself exited: stop the idle timer so a lingering descendant holding stdout can never trigger stalled-stream.
        clearIdle();
        scheduleExitCleanup();
      });

      child.on("error", (error) => done(() => reject(new Error(`could not start dsh (${bin}): ${error.message}`))));

      child.on("close", (code, signal) => {
        if (exitDrainTimer) { clearTimeout(exitDrainTimer); exitDrainTimer = undefined; }
        if (exitKillTimer) { clearTimeout(exitKillTimer); exitKillTimer = undefined; }
        if (brokenPipe) {
          waitGroupThen(() => {
            const exit = pipeErrorCode === "EPIPE" ? 128 + (constants.signals.SIGPIPE ?? 13) : 1;
            done(() => resolve(exit));
          });
          return;
        }
        if (timedOut) {
          waitGroupThen(emitStalledAndResolve);
          return;
        }
        const finalSignal = exitSignal ?? signal;
        const finalCode = finalSignal ? 128 + (constants.signals[finalSignal] ?? 0) : (exitCode ?? code ?? 1);
        const finishNormal = () => {
          if (watchIdle) {
            writeFlushed(stdout, "").then(() => done(() => resolve(finalCode)));
          } else {
            done(() => resolve(finalCode));
          }
        };
        if (exitCleanupActive) {
          waitGroupThen(finishNormal);
        } else {
          finishNormal();
        }
      });
    });
  } finally {
    process.removeListener("exit", onExit);
    cleanup();
  }
}
