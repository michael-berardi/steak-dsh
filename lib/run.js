/** `steak-dsh run`: one headless dsh run with the overlays applied; exit with dsh's exit code. */
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { launchEnv } from "./dsh.js";
import { headlessArgs, overlayFiles } from "./overlay.js";

export async function runCommand(o, task, { root, bin }) {
  const { files, cleanup } = overlayFiles(o, root);
  const onExit = () => cleanup();
  process.once("exit", onExit);
  const args = headlessArgs(o, files, task);
  try {
    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(bin, args, { stdio: "inherit", env: launchEnv(), detached: true });
      } catch (error) {
        reject(new Error(`could not start dsh (${bin}): ${error.message}`));
        return;
      }
      // The child runs in its own process group so a terminal Ctrl-C reaches it only through us.
      const forward = (signal) => {
        try { process.kill(-child.pid, signal); } catch { /* already gone */ }
      };
      const handlers = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"].map((signal) => {
        const handler = () => forward(signal);
        process.on(signal, handler);
        return [signal, handler];
      });
      const done = (finish) => {
        for (const [signal, handler] of handlers) process.removeListener(signal, handler);
        cleanup();
        finish();
      };
      child.on("error", (error) => done(() => reject(new Error(`could not start dsh (${bin}): ${error.message}`))));
      child.on("close", (code, signal) => done(() => {
        resolve(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1));
      }));
    });
  } finally {
    process.removeListener("exit", onExit);
    cleanup();
  }
}
