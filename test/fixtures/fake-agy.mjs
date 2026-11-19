#!/usr/bin/env node
// A fake `agy` for the route tests: prints stream-json shaped exactly like Google's headless-mode docs.
// FAKE_AGY_MODE: text | tool | error | canceled | interrupted | invalid | badmodel | signedout | signedout-hang | hang | hang-stubborn | silent-exit
// FAKE_AGY_LOG: a file that gets one JSON line per launch ({argv, cwd, pid, child}).
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_AGY_MODE ?? "text";
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const CID = "c3b66b04-872b-4fbe-a3a4-058a026ef20a";
const usage = { input_tokens: 10418, output_tokens: 589, thinking_tokens: 551, cache_read_tokens: 8113, total_tokens: 11007 };
const zero = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 };
const result = (status, response, error, u = usage) => out({ event: "result", result: { conversation_id: status === "SUCCESS" ? CID : "", status, response, ...(error ? { error } : {}), duration_seconds: 1.2, num_turns: 1, usage: u } });
const step = (fields) => out({ event: "step_update", step_update: { conversation_id: CID, ...fields } });
const init = () => out({ event: "init", conversation_id: CID, init: { cwd: process.cwd(), tools: ["run_command", "write_to_file"], permission_mode: "request-review" } });

let child;
if (process.env.FAKE_AGY_LOG) {
  if (mode.startsWith("hang")) child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid, child: child?.pid })}\n`);
}

if (argv[0] === "models") {
  if (mode.startsWith("signedout")) {
    process.stderr.write("Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.\n");
    process.exit(1);
  }
  process.stderr.write("Fetching available models...\n");
  process.stdout.write(process.env.FAKE_AGY_MODELS ?? "gemini-4-neon-high Gemini 4 Neon (High)\ngemini-4-neon-low Gemini 4 Neon (Low)\ngemini-3.8-flash-medium Gemini 3.8 Flash (Medium)\n");
  process.exit(0);
}

const prompt = argv[argv.indexOf("-p") + 1];
switch (mode) {
  case "text":
    init();
    step({ step_index: 0, state: "DONE", step_type: "user_input" });
    step({ step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: process.env.FAKE_AGY_FIRST ?? "Git rebase " });
    step({ step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "rewrites history" });
    step({ step_index: 2, state: "DONE", step_type: "agent_response", text_delta: ".\n", duration_seconds: 6.28, usage });
    step({ step_index: 4, state: "DONE", step_type: "checkpoint", duration_seconds: 0.53, usage: { input_tokens: 116, output_tokens: 7, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 123 } });
    result("SUCCESS", "Git rebase rewrites history.\n");
    break;
  case "tool":
    init();
    step({ step_index: 0, state: "DONE", step_type: "user_input" });
    step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Let me check." });
    step({ step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "run_command" });
    step({ step_index: 2, state: "DONE", step_type: "tool", tool_name: "run_command", duration_seconds: 0.07, tool_info: { name: "run_command", parameters: { CommandLine: "echo hello_headless_demo" }, output: "hello_headless_demo\r\n" } });
    step({ step_index: 3, state: "DONE", step_type: "tool", tool_name: "write_to_file", tool_info: { name: "write_to_file", parameters: { TargetFile: "/x" }, error: { type: "permission_denied", message: "denied by rule" } } });
    step({ step_index: 4, state: "DONE", step_type: "agent_response", text_delta: "It printed hello_headless_demo.\n" });
    result("SUCCESS", "Let me check.It printed hello_headless_demo.\n");
    break;
  case "error": init(); result("ERROR", "", process.env.FAKE_AGY_ERROR ?? "model quota exhausted", zero); process.exitCode = 1; break;
  case "badmodel": result("ERROR", "", `invalid model selection (--model "${argv[argv.indexOf("--model") + 1]}" --effort ""): model is not recognized as a known model or custom model in settings\nAvailable models:\n Gemini 3.6 Flash (High)\n ...`, zero); process.exitCode = 1; break;
  case "canceled": init(); result("CANCELED", "", undefined, zero); break;
  case "interrupted": init(); result("INTERRUPTED", "", undefined, zero); break;
  case "invalid": init(); result("INVALID", "", undefined, zero); break;
  case "silent-exit": process.stderr.write("boom: something broke\n"); process.exitCode = 3; break;
  case "signedout":
    process.stderr.write("Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?x=y\n\nWaiting for authentication (timeout 60s)...\n");
    result("ERROR", "", "authentication failed or timed out", zero);
    process.exitCode = 1;
    break;
  case "signedout-hang":
    // The real agy waits 60 s for a browser sign-in. On SIGINT it writes its result and leaves.
    process.stderr.write("Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?x=y\n\nWaiting for authentication (timeout 60s)...\n");
    process.on("SIGINT", () => { result("ERROR", "", "authentication failed or timed out", zero); process.exit(1); });
    setTimeout(() => process.exit(1), 60_000);
    break;
  case "hang":
  case "hang-stubborn":
    init();
    step({ step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "working" });
    if (mode === "hang-stubborn") { process.on("SIGINT", () => {}); process.on("SIGTERM", () => {}); }
    setTimeout(() => process.exit(0), 120_000);
    break;
  default: process.stderr.write(`fake agy: unknown mode ${mode} (${prompt})\n`); process.exit(9);
}
