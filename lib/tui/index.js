/** `steak-dsh tui`: wire the overlay, the controller and the terminal app together. */
import { launchEnv } from "../dsh.js";
import { UsageError } from "../errors.js";
import { overlayFiles } from "../overlay.js";
import { runPlain, TerminalApp } from "./app.js";
import { Controller } from "./session.js";
import { createTheme, detectColorMode } from "./theme.js";

/** The dsh argument list for the SDK profile: `--profile sdk` plus the same overlay patch files chat uses. */
export function sdkArgs(files) {
  const args = ["--profile", "sdk"];
  for (const file of files) args.push("--patch", file);
  return args;
}

export async function tuiCommand(o, { root, bin, stdin = process.stdin, stdout = process.stdout, env = process.env }) {
  if (o.model === undefined) {
    throw new UsageError("tui needs --model <provider>/<model-id>: the SDK wire has to be told which model to run (chat and run use the profile default)");
  }
  if (o.json) throw new UsageError("--json applies to run only");
  const { files, cleanup } = overlayFiles(o, root);
  process.once("exit", cleanup);
  const theme = createTheme({ mode: detectColorMode(env, stdout) });
  const controller = new Controller({ bin, args: sdkArgs(files), options: o, cwd: process.cwd(), env: launchEnv(env) });
  const onSignal = (signal, code) => () => {
    controller.quit().finally(() => { cleanup(); process.exit(128 + code); });
    void signal;
  };
  const handlers = [["SIGTERM", 15], ["SIGHUP", 1], ["SIGINT", 2]].map(([signal, code]) => {
    const handler = onSignal(signal, code);
    process.on(signal, handler);
    return [signal, handler];
  });
  try {
    if (stdout.isTTY && stdin.isTTY) return await new TerminalApp({ controller, stdin, stdout, theme }).run();
    return await runPlain({ controller, stdin, stdout, theme, width: stdout.columns || 80 });
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    process.removeListener("exit", cleanup);
    cleanup();
  }
}
