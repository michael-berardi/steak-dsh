/**
 * `steak-dsh chat`: a line-based terminal chat. Each line is one headless dsh turn with --json;
 * events render as they arrive, the session id from the first `session` event continues the conversation.
 * /exit or Ctrl-D quits; Ctrl-C cancels the running turn; /new starts a fresh session.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { launchEnv } from "./dsh.js";
import { headlessArgs, overlayFiles } from "./overlay.js";
import { countEvent, renderEvent, summaryLine } from "./render.js";

export async function chatCommand(o, { root, bin }) {
  const { files, cleanup } = overlayFiles(o, root);
  process.once("exit", cleanup);
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const dim = (text) => (color ? `\x1b[2m${text}\x1b[0m` : text);
  const red = (text) => (color ? `\x1b[31m${text}\x1b[0m` : text);
  let sessionId = o.sessionId;
  let current;

  const turn = (text) => new Promise((resolve) => {
    const args = headlessArgs({ ...o, json: true, sessionId }, files, [text]);
    const totals = { turns: 0, tokens: 0 };
    let firstSession;
    let buffer = "";
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "inherit"], env: launchEnv(), detached: true });
    } catch (error) {
      process.stdout.write(red(`error: could not start dsh (${bin}): ${error.message}`) + "\n");
      resolve({});
      return;
    }
    current = child;
    const handle = (event) => {
      if (event?.type === "session" && firstSession === undefined) firstSession = event.sessionId;
      countEvent(totals, event);
      for (const line of renderEvent(event, { color })) process.stdout.write(line + "\n");
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try { handle(JSON.parse(line)); } catch { /* not an event line; dsh owns stdout */ }
      }
    });
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      current = undefined;
      if (buffer.trim()) {
        try { handle(JSON.parse(buffer.trim())); } catch { /* ignore a partial trailing line */ }
      }
      if (signal) process.stdout.write(dim(`turn cancelled (${signal})`) + "\n");
      else if (code !== 0) process.stdout.write(red(`turn failed: dsh exit code ${code}`) + "\n");
      process.stdout.write(summaryLine(totals, { color }) + "\n");
      resolve({ sessionId: firstSession });
    };
    child.on("error", (error) => {
      process.stdout.write(red(`error: could not start dsh (${bin}): ${error.message}`) + "\n");
      finish(1);
    });
    child.on("close", finish);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  rl.setPrompt("steak> ");
  rl.on("SIGINT", () => {
    if (current) {
      try { process.kill(-current.pid, "SIGTERM"); } catch { /* already gone */ }
    } else {
      rl.close();
    }
  });
  rl.prompt();
  try {
    for await (const line of rl) {
      const text = line.trim();
      if (text === "/exit") break;
      if (text === "/new") {
        sessionId = undefined;
        process.stdout.write(dim("new session") + "\n");
      } else if (text) {
        const result = await turn(text);
        if (sessionId === undefined && result.sessionId !== undefined) sessionId = result.sessionId;
      }
      rl.prompt();
    }
  } finally {
    rl.close();
    process.removeListener("exit", cleanup);
    cleanup();
  }
  return 0;
}
