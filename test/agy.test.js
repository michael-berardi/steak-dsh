// The agy route: Google's official Antigravity CLI in headless mode, with a fake `agy` (test/fixtures/fake-agy.mjs)
// that prints stream-json shaped like the docs' examples. The real agy is never started and nobody signs in.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { loadHarness } from "../claude-code/harness.js";
import { createAgyAdapter, agyEffort, buildPrompt } from "../agy/adapter.js";
import { agyStatus, listAgyModels } from "../agy/cli.js";
import { INSTALL_COMMAND } from "../agy/errors.js";
import { defaultSources } from "../lib/models.js";

const root = join(import.meta.dirname, "..");
const FAKE = join(root, "test", "fixtures", "fake-agy.mjs");
const launcher = join(root, "bin", "steak-dsh");
const harness = await loadHarness({ entry: "/nonexistent" });
const dshOnPath = (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, "dsh")));

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "steak-dsh-agy-")));
const readAll = (log) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const readLog = (log) => readAll(log).filter((l) => l.argv); // one entry per launch
const prompts = (log) => readAll(log).filter((l) => l.stdin).map((l) => l.stdin);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const user = (text) => ({ role: "user", id: "u", source: { kind: "user" }, content: [{ type: "text", text }] });
const assistant = (text, replayState) => ({ role: "assistant", id: "a", source: { kind: "model", ...(replayState ? { replayState } : {}) }, content: [{ type: "text", text }] });

function setup(t, mode = "text", extra = {}, settings = {}) {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "fake.log");
  const env = { PATH: process.env.PATH, HOME: dir, STEAK_DSH_AGY_BIN: FAKE, FAKE_AGY_MODE: mode, FAKE_AGY_LOG: log, ...extra };
  const reports = [];
  const adapter = createAgyAdapter(harness, { env: () => env, report: (m) => reports.push(m), ...settings });
  return { dir, log, env, adapter, reports };
}

async function collect(adapter, options) {
  const chunks = [];
  for await (const chunk of adapter.stream({ provider: "agy", model: "gemini-4-neon-high", tools: [], messages: [user("hi")], ...options })) chunks.push(chunk);
  return chunks;
}
const textOf = (chunks) => chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
async function failure(adapter, options) {
  try { await collect(adapter, options); } catch (error) { return error; }
  assert.fail("expected the request to fail");
}

// ---- models, missing, signed out ----

test("models: `agy models` rows become ids; the plan decides the list", async (t) => {
  const { env } = setup(t);
  const rows = await listAgyModels(env);
  assert.deepEqual(rows.map((r) => r.id), ["gemini-4-neon-high", "gemini-4-neon-low", "gemini-3.8-flash-medium"]);
  assert.equal(rows[0].name, "Gemini 4 Neon (High)");
  const sources = defaultSources({ ...env, DSH_HOME: join(env.HOME, "none"), PI_CODING_AGENT_DIR: join(env.HOME, "none") });
  assert.deepEqual(await sources.agy(), rows.map((r) => r.id));
});

test("models: steak-dsh models --provider agy prints agy/<id>, sorted", (t) => {
  const { env } = setup(t);
  const run = spawnSync(process.execPath, [launcher, "models", "--provider", "agy"], { encoding: "utf8", env });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "agy/gemini-3.8-flash-medium\nagy/gemini-4-neon-high\nagy/gemini-4-neon-low\n");
});

test("missing agy: every entry names the cause and the official install command", async (t) => {
  const { env, adapter, dir } = setup(t, "text", { STEAK_DSH_AGY_BIN: undefined, PATH: "/nonexistent-bin-dir" });
  await assert.rejects(listAgyModels(env), (e) => e.code === "AGY_MISSING" && e.message.includes(INSTALL_COMMAND));
  assert.equal(INSTALL_COMMAND, "curl -fsSL https://antigravity.google/cli/install.sh | bash");
  const error = await failure(adapter, {});
  assert.equal(error.code, "AGY_MISSING");
  assert.match(error.message, /curl -fsSL https:\/\/antigravity\.google\/cli\/install\.sh \| bash/);
  const status = await agyStatus(env);
  assert.equal(status.available, false);
  const run = spawnSync(process.execPath, [launcher, "models", "--provider", "agy"], { encoding: "utf8", env: { ...env, STEAK_DSH_AGY_BIN: join(dir, "no-such-agy") } });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /AGY_MISSING/);
  assert.ok(run.stderr.includes(INSTALL_COMMAND));
  assert.match(run.stderr, /STEAK_DSH_AGY_BIN points at/);
});

test("signed out: `agy models` fails with agy's own words plus the sign-in hint", async (t) => {
  const { env } = setup(t, "signedout");
  await assert.rejects(listAgyModels(env), (e) => e.code === "AGY_NOT_SIGNED_IN"
    && e.message.includes("Please sign in to view available models") && e.message.endsWith("run agy once to sign in"));
  const status = await agyStatus(env);
  assert.equal(status.available, true);
  assert.equal(status.signedIn, false);
});

test("signed out: a run (exit 1, result ERROR 'authentication failed or timed out') is a named sign-in error", async (t) => {
  const { adapter } = setup(t, "signedout");
  const error = await failure(adapter, {});
  assert.equal(error.code, "AGY_NOT_SIGNED_IN");
  assert.match(error.message, /authentication failed or timed out/);
  assert.match(error.message, /run agy once to sign in/);
});

test("signed out, agy waiting for a browser sign-in: stopped at once, not after its 60 s wait", async (t) => {
  const { adapter, log } = setup(t, "signedout-hang");
  const started = Date.now();
  const error = await failure(adapter, {});
  assert.ok(Date.now() - started < 15_000, "stopped promptly");
  assert.equal(error.code, "AGY_NOT_SIGNED_IN");
  assert.match(error.message, /authentication failed or timed out/, "agy's own result text, written when it was interrupted");
  assert.match(error.message, /run agy once to sign in/);
  assert.equal(alive(readLog(log)[0].pid), false);
});

// ---- a run ----

test("run: ACTIVE deltas, DONE and SUCCESS reach the harness as text, usage and a stop", async (t) => {
  const { adapter, log, dir } = setup(t);
  const chunks = await collect(adapter, {});
  assert.equal(textOf(chunks), "Git rebase rewrites history.\n");
  assert.deepEqual(chunks.map((c) => c.type), ["block-start", "text-delta", "text-delta", "text-delta", "block-end", "usage", "finish"]);
  assert.deepEqual(chunks.find((c) => c.type === "block-end").block, { type: "text", text: "Git rebase rewrites history.\n" });
  assert.deepEqual(chunks.find((c) => c.type === "usage").usage, {
    inputTokens: 10418 - 8113, outputTokens: 589, totalTokens: 11007, cacheReadTokens: 8113, cacheWriteTokens: 0, reasoningTokens: 551,
  });
  const finish = chunks.at(-1);
  assert.deepEqual(finish.reason, { kind: "stop" });
  assert.equal(finish.replayState.agy.conversationId, "c3b66b04-872b-4fbe-a3a4-058a026ef20a");
  const [launch] = readLog(log);
  assert.deepEqual(launch.argv.slice(0, 5), ["--input-format", "stream-json", "--output-format", "stream-json", "--model"]);
  assert.equal(launch.argv.includes("-p") || launch.argv.includes("hi"), false, "the prompt is not on argv");
  assert.deepEqual(prompts(log), [{ events: 1, prompt: "hi" }]);
  assert.ok(launch.argv.includes("--add-dir") && launch.argv[launch.argv.indexOf("--add-dir") + 1] === realpathSync(process.cwd()));
  assert.equal(launch.argv.includes("--effort"), false, "no effort unless asked");
  assert.equal(launch.argv.includes("--conversation"), false);
  assert.equal(launch.cwd, realpathSync(process.cwd()));
  assert.equal(alive(launch.pid), false);
  void dir;
});

test("run: a tool step is progress text, never a harness tool call", async (t) => {
  const { adapter } = setup(t, "tool");
  const chunks = await collect(adapter, { tools: [{ name: "bash", description: "x", inputSchema: { type: "object" } }] });
  assert.equal(chunks.some((c) => c.type.startsWith("tool-call") || (c.type === "block-start" && c.blockType !== "text")), false);
  const text = textOf(chunks);
  assert.equal(text, "Let me check.\n[agy tool: run_command echo hello_headless_demo]\n[agy tool: write_to_file /x failed: denied by rule]\nIt printed hello_headless_demo.\n");
  assert.equal(chunks.filter((c) => c.type === "finish").length, 1);
});

test("run: --dangerously-skip-permissions is never passed, in any mode or with any effort", async (t) => {
  for (const mode of ["text", "tool"]) {
    const { adapter, log } = setup(t, mode);
    await collect(adapter, { reasoningEffort: "high" });
    for (const launch of readLog(log)) assert.equal(launch.argv.some((a) => /dangerously|skip-permissions/.test(a)), false);
  }
  const source = ["agy/cli.js", "agy/adapter.js", "agy/stream.js", "agy/plugin.js"].map((f) => readFileSync(join(root, f), "utf8")).join("\n");
  assert.equal(/["'`]--dangerously-skip-permissions["'`]/.test(source), false, "the flag is never built into an argument list");
});

test("run: a slash at the start of the task is sent as typed, not run as an agy command", async (t) => {
  const { adapter, log } = setup(t);
  await collect(adapter, { messages: [user("/etc/hosts has a bad entry")] });
  const [launch] = readLog(log);
  assert.equal(prompts(log)[0].prompt, "/etc/hosts has a bad entry");
  assert.ok(launch.argv.includes("--disable-slash-commands"));
});

test("effort: off maps to low, agy's own levels pass through, anything else is a named error", async (t) => {
  assert.equal(agyEffort(undefined), undefined);
  assert.equal(agyEffort("off"), "low");
  for (const level of ["low", "medium", "high", "xhigh", "max"]) assert.equal(agyEffort(level), level);
  assert.throws(() => agyEffort("ludicrous"), (e) => e.code === "AGY_BAD_REQUEST" && /ludicrous/.test(e.message));
  for (const [asked, sent] of [["off", "low"], ["medium", "medium"], ["xhigh", "xhigh"]]) {
    const { adapter, log } = setup(t);
    await collect(adapter, { reasoningEffort: asked });
    const { argv } = readLog(log)[0];
    assert.equal(argv[argv.indexOf("--effort") + 1], sent);
  }
});

test("conversation: a later turn resumes agy's conversation and sends only what the user said since", async (t) => {
  const { adapter, log } = setup(t);
  const first = await collect(adapter, { messages: [user("first")] });
  const replayState = first.at(-1).replayState;
  await collect(adapter, { messages: [user("first"), assistant("Git rebase rewrites history.", replayState), user("second"), user("third")] });
  const [, second] = readLog(log);
  assert.equal(prompts(log).at(-1).prompt, "second\n\nthird");
  assert.equal(second.argv[second.argv.indexOf("--conversation") + 1], "c3b66b04-872b-4fbe-a3a4-058a026ef20a");
});

test("prompt: without a saved agy conversation the visible history is sent as text; images and an assistant-last history are refused", () => {
  const { prompt, conversationId } = buildPrompt([user("a"), assistant("b"), user("c")]);
  assert.equal(conversationId, undefined);
  assert.equal(prompt, "User: a\n\nAssistant: b\n\nUser: c");
  assert.throws(() => buildPrompt([{ role: "user", content: [{ type: "image", data: "x" }] }]), (e) => e.code === "AGY_BAD_REQUEST");
  assert.throws(() => buildPrompt([user("a"), assistant("b")]), (e) => e.code === "AGY_BAD_REQUEST");
});

test("a model id that could be read as a flag never reaches agy", async (t) => {
  const { adapter, log } = setup(t);
  const error = await failure(adapter, { model: "--dangerously-skip-permissions" });
  assert.equal(error.code, "AGY_BAD_REQUEST");
  assert.equal(readLog(log).length, 0);
});

// ---- result statuses ----

test("status ERROR carries agy's own text under a named code", async (t) => {
  const { adapter } = setup(t, "error", { FAKE_AGY_ERROR: "model quota exhausted" });
  const error = await failure(adapter, {});
  assert.equal(error.code, "AGY_FAILED");
  assert.match(error.message, /model quota exhausted/);
});

test("status ERROR from an unknown model: the plan lacks it, named, with the way to see what it has", async (t) => {
  const { adapter } = setup(t, "badmodel");
  const error = await failure(adapter, { model: "gemini-9-nope" });
  assert.equal(error.code, "AGY_MODEL_UNAVAILABLE");
  assert.match(error.message, /gemini-9-nope/);
  assert.match(error.message, /steak-dsh models --provider agy/);
});

test("resolveModel: a model the plan does not list is refused before any run; a listed one carries the effort levels", async (t) => {
  const { adapter, log } = setup(t);
  const listed = await adapter.resolveModel("agy", "gemini-4-neon-high");
  assert.deepEqual(listed.reasoning.efforts.map((e) => e.name), ["off", "low", "medium", "high", "xhigh", "max"]);
  await assert.rejects(adapter.resolveModel("agy", "gemini-9-nope"), (e) => e.code === "AGY_MODEL_UNAVAILABLE" && /not in this plan's list/.test(e.message));
  assert.equal(readLog(log).filter((l) => l.argv[0] !== "models").length, 0);
  assert.deepEqual((await adapter.listModels("agy")).map((m) => m.id).sort(), ["gemini-3.8-flash-medium", "gemini-4-neon-high", "gemini-4-neon-low"]);
});

test("resolveModel with agy signed out: no models offered, the reason reported once", async (t) => {
  const { adapter, reports } = setup(t, "signedout");
  assert.deepEqual(await adapter.listModels("agy"), []);
  await adapter.listModels("agy");
  assert.equal(reports.length, 1);
  assert.match(reports[0], /run agy once to sign in/);
});

test("status CANCELED, INTERRUPTED and INVALID are named, and exit-without-result names agy's last words", async (t) => {
  for (const [mode, code, pattern] of [["canceled", "AGY_CANCELLED", /CANCELED/], ["interrupted", "AGY_CANCELLED", /INTERRUPTED/], ["invalid", "AGY_INVALID", /INVALID/], ["silent-exit", "AGY_FAILED", /code 3.*boom: something broke/]]) {
    const { adapter } = setup(t, mode);
    const error = await failure(adapter, {});
    assert.equal(error.code, code, mode);
    assert.match(error.message, pattern, mode);
  }
});

test("a run that exceeds the time limit is stopped and named", async (t) => {
  const { adapter, log } = setup(t, "hang", {}, { timeoutMs: 400 });
  const error = await failure(adapter, {});
  assert.equal(error.code, "AGY_TIMEOUT");
  const [launch] = readLog(log);
  assert.equal(alive(launch.pid), false);
  assert.equal(alive(launch.child), false);
});

test("prompt on stdin: text that looks like a flag, and a 300 KB non-ASCII prompt, arrive intact and never touch argv", async (t) => {
  const { adapter, log } = setup(t);
  const flaggy = "--dangerously-skip-permissions please";
  await collect(adapter, { messages: [user(flaggy)] });
  const big = "héllo wörld — 日本語 🚀 ".repeat(12_000);
  assert.ok(Buffer.byteLength(big) > 300_000);
  await collect(adapter, { messages: [user(big)] });
  const sent = prompts(log);
  assert.equal(sent[0].prompt, flaggy);
  assert.equal(sent[1].prompt, big);
  for (const launch of readLog(log)) {
    assert.equal(launch.argv.some((a) => /dangerously|skip-permissions|héllo/.test(a)), false);
    assert.ok(JSON.stringify(launch.argv).length < 1_000);
  }
});

test("prompt: a replayed history is capped by bytes, oldest turns first, and the prompt says so", () => {
  const chunk = "x".repeat(60_000);
  const messages = [user(`first ${chunk}`), assistant(`second ${chunk}`), user(`third ${chunk}`), assistant(`fourth ${chunk}`), user("last question")];
  const { prompt } = buildPrompt(messages);
  assert.ok(Buffer.byteLength(prompt) < 210_000);
  assert.match(prompt, /^\[Steak DSH: the \d+ oldest turns? of this conversation were left out/);
  assert.equal(prompt.includes("first x"), false);
  assert.ok(prompt.endsWith("User: last question"));
  assert.equal(buildPrompt([user("a"), assistant("b"), user("c")]).prompt, "User: a\n\nAssistant: b\n\nUser: c", "small histories are untouched");
});

test("cleanup: after a successful run, a SIGINT/SIGTERM-proof grandchild holding stdout is killed and cannot hang the run", { timeout: 20_000 }, async (t) => {
  const { adapter, log } = setup(t, "grandchild");
  const started = Date.now();
  const chunks = await collect(adapter, {});
  assert.equal(textOf(chunks), "done\n");
  assert.ok(Date.now() - started < 10_000, "did not wait on the grandchild's stdout");
  const gc = readAll(log).find((l) => l.grandchild).grandchild;
  assert.equal(alive(readLog(log)[0].pid), false);
  for (let i = 0; i < 40 && alive(gc); i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(gc), false, "the grandchild was killed with agy's process group");
});

test("sign-in URL: no URL or control character from agy reaches an error, a notice or the report", async (t) => {
  const { adapter, reports } = setup(t, "leak");
  const error = await failure(adapter, {});
  const shown = [error.message, ...reports].join("\n");
  assert.equal(error.code, "AGY_NOT_SIGNED_IN");
  assert.doesNotMatch(shown, /https?:|accounts\.google\.com|client_id/);
  assert.doesNotMatch(shown, /[\u0000-\u0008\u000b-\u001f\u007f]/);
});

// ---- abort ----

test("abort: SIGINT to the process group ends agy and its children; nothing is left alive", async (t) => {
  const { adapter, log } = setup(t, "hang");
  const controller = new AbortController();
  const seen = [];
  const run = (async () => {
    for await (const chunk of adapter.stream({ provider: "agy", model: "gemini-4-neon-high", tools: [], messages: [user("hi")], signal: controller.signal })) {
      seen.push(chunk);
      if (chunk.type === "text-delta") controller.abort(new Error("user stopped"));
    }
  })();
  await assert.rejects(run, (e) => e.code === "AGY_CANCELLED");
  assert.equal(seen.some((c) => c.type === "text-delta"), true);
  const [launch] = readLog(log);
  assert.equal(alive(launch.pid), false, "agy is gone");
  assert.equal(alive(launch.child), false, "so is its child");
});

test("abort: an agy that ignores SIGINT and SIGTERM is killed within the bounded steps", { timeout: 30_000 }, async (t) => {
  const { adapter, log } = setup(t, "hang-stubborn");
  const controller = new AbortController();
  const run = (async () => {
    for await (const chunk of adapter.stream({ provider: "agy", model: "gemini-4-neon-high", tools: [], messages: [user("hi")], signal: controller.signal })) {
      if (chunk.type === "text-delta") controller.abort(new Error("stop"));
    }
  })();
  const started = Date.now();
  await assert.rejects(run, (e) => e.code === "AGY_CANCELLED");
  assert.ok(Date.now() - started < 12_000, "bounded");
  const [launch] = readLog(log);
  assert.equal(alive(launch.pid), false);
  assert.equal(alive(launch.child), false);
});

test("abort: a consumer that stops reading early leaves no live agy", async (t) => {
  const { adapter, log } = setup(t, "hang");
  for await (const chunk of adapter.stream({ provider: "agy", model: "gemini-4-neon-high", tools: [], messages: [user("hi")] })) {
    if (chunk.type === "text-delta") break;
  }
  const [launch] = readLog(log);
  assert.equal(alive(launch.pid), false);
  assert.equal(alive(launch.child), false);
});

// ---- the launcher ----

test("the retired antigravity config: doctor and --model antigravity/... print one removal line", { skip: !dshOnPath }, (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "dsh-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "steak-dsh-antigravity.json"), '{"enabled":true}\n');
  const env = { PATH: process.env.PATH, HOME: dir, DSH_HOME: home, STEAK_DSH_AGY_BIN: FAKE, FAKE_AGY_MODE: "text" };
  const line = "removed because Google's terms forbid third-party Antigravity OAuth; use --model agy/<id>";
  const doctor = spawnSync(process.execPath, [launcher, "doctor"], { encoding: "utf8", env });
  assert.equal(doctor.status, 0, doctor.stderr + doctor.stdout);
  assert.equal(doctor.stdout.split("\n").filter((l) => l.includes("Google's terms forbid")).length, 1);
  assert.ok(doctor.stdout.includes(line));
  assert.match(doctor.stdout, /agy: .*fake-agy\.mjs \(installed; signed in; 3 models\)/);
  const run = spawnSync(process.execPath, [launcher, "run", "--model", "antigravity/anything", "hi"], { encoding: "utf8", env });
  assert.equal(run.status, 2);
  assert.ok(run.stderr.includes(line), run.stderr);
  assert.equal(run.stderr.trim().split("\n").length, 1);
  assert.equal(spawnSync(process.execPath, [launcher, "antigravity", "login"], { encoding: "utf8", env }).status, 2, "the antigravity command is gone");
});

test("doctor: agy missing and agy signed out are each reported with their cause", { skip: !dshOnPath }, (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = { PATH: process.env.PATH, HOME: dir, DSH_HOME: join(dir, "h") };
  const missing = spawnSync(process.execPath, [launcher, "doctor"], { encoding: "utf8", env: { ...base, STEAK_DSH_AGY_BIN: join(dir, "none") } });
  assert.ok(missing.stdout.includes(`agy: not found`) && missing.stdout.includes(INSTALL_COMMAND), missing.stdout);
  assert.equal(missing.stdout.includes("Google's terms forbid"), false, "no old config, no removal line");
  const out = spawnSync(process.execPath, [launcher, "doctor"], { encoding: "utf8", env: { ...base, STEAK_DSH_AGY_BIN: FAKE, FAKE_AGY_MODE: "signedout" } });
  assert.match(out.stdout, /agy: .* \(installed; NOT signed in\): .*Please sign in.*run agy once to sign in/);
});

// ---- inside a real dsh run ----

function runDsh(args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [launcher, "run", "--json", ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, events: stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)) }); });
  });
}

test("dsh headless: an agy/<id> model answers through the route, tool steps as text, and no agy outlives the run", { skip: !dshOnPath }, async (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "fake.log");
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: join(dir, "dsh-home"), STEAK_DSH_AGY_BIN: FAKE, FAKE_AGY_MODE: "tool", FAKE_AGY_LOG: log };
  const { status, events, stderr, stdout } = await runDsh(["--model", "agy/gemini-4-neon-high", "--effort", "off", "say hi"], env, dir);
  assert.equal(status, 0, stderr + stdout.slice(-800));
  const final = events.find((e) => e.type === "final");
  assert.equal(final.reason.kind, "completed");
  assert.match(final.text, /\[agy tool: run_command echo hello_headless_demo\]/);
  assert.match(final.text, /It printed hello_headless_demo\./);
  const runs = readLog(log).filter((l) => l.argv.includes("--input-format"));
  assert.equal(runs.length, 1, "one agy run per harness turn");
  assert.equal(runs[0].argv[runs[0].argv.indexOf("--effort") + 1], "low");
  assert.equal(runs[0].cwd, realpathSync(dir));
  for (const launch of readLog(log)) assert.equal(alive(launch.pid), false);
});

test("dsh headless: a signed-out agy fails the run with the named cause", { skip: !dshOnPath }, async (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: join(dir, "dsh-home"), STEAK_DSH_AGY_BIN: FAKE, FAKE_AGY_MODE: "signedout" };
  const { status, stderr, stdout } = await runDsh(["--model", "agy/gemini-4-neon-high", "say hi"], env, dir);
  assert.notEqual(status, 0);
  assert.match(stderr + stdout, /run agy once to sign in/);
});
