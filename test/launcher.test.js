import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(root, "bin", "steak-dsh");
const bundlePatch = join(root, "cordis.patch.yml");
const { LONG_PROFILE_PATCH, buildRows } = await import(join(root, "lib", "overlay.js"));
const longPatch = join(root, LONG_PROFILE_PATCH);

const FAKE_DSH = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  process.stdout.write((process.env.FAKE_DSH_VERSION ?? "0.2.2-rc.1") + "\\n");
  process.exit(0);
}
if (process.env.FAKE_DSH_SELF_SIGNAL) {
  process.kill(process.pid, process.env.FAKE_DSH_SELF_SIGNAL);
}
const patches = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--patch") patches.push({ path: argv[i + 1], content: readFileSync(argv[i + 1], "utf8") });
}
appendFileSync(process.env.FAKE_DSH_RECORD, JSON.stringify({ argv, patches, pid: process.pid, telemetry: process.env.DSH_TELEMETRY_MODE }) + "\\n");
if (process.env.FAKE_DSH_SLEEP) {
  process.on("SIGINT", () => {
    appendFileSync(process.env.FAKE_DSH_RECORD, JSON.stringify({ signal: "SIGINT" }) + "\\n");
    process.exit(42);
  });
  setTimeout(() => process.exit(0), 15000);
} else {
  process.stdout.write(JSON.stringify({ type: "session", sessionId: "sess-1", cwd: process.cwd() }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "text", text: "canned reply" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "final", sessionId: "sess-1", reason: { kind: "completed" }, text: "canned reply" }) + "\\n");
  process.exit(Number(process.env.FAKE_DSH_EXIT ?? 0));
}
`;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-launcher-test-"));
  const fake = join(dir, "fake-dsh.mjs");
  writeFileSync(fake, FAKE_DSH, { mode: 0o755 });
  return { dir, fake, record: join(dir, "record.jsonl") };
}

function run(args, s, env = {}) {
  const result = spawnSync(process.execPath, [launcher, ...args], {
    cwd: s.dir,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, STEAK_DSH_DSH_BIN: s.fake, FAKE_DSH_RECORD: s.record, DSH_HOME: join(s.dir, "home"), ...env },
  });
  return result;
}

const records = (s) => readFileSync(s.record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const generated = (rec) => {
  const patch = rec.patches.find((p) => p.path.includes("steak-dsh-") && p.path.endsWith("overlay.yml"));
  assert.ok(patch, "a generated overlay was passed");
  return { patch, rows: JSON.parse(patch.content) };
};

test("overlay order and generated rows for every flag; secrets never leak; temp overlay removed", () => {
  const s = scratch();
  try {
    const userPatch = join(s.dir, "user.yml");
    writeFileSync(userPatch, "- id: system-prompt\n  config: {}\n");
    const result = run([
      "run", "--model", "acme/org/model-x", "--base-url", "https://gw.example/v1", "--api", "openai-completions",
      "--key-env", "STEAK_TEST_KEY", "--compat", '{"supportsDeveloperRole":false}', "--context-window", "12345",
      "--effort", "high", "--no-shell", "--owned-path", "/abs/owned", "--verify", "npm test",
      "--patch", userPatch, "--json", "--permission", "read-only", "--add-dir", "/abs/extra",
      "--session-id", "s1", "do", "the task",
    ], s, { STEAK_TEST_KEY: "SECRET-SENTINEL-VALUE" });
    assert.equal(result.status, 0, result.stderr);
    const [rec] = records(s);
    assert.deepEqual(rec.argv, [
      "headless", "--patch", bundlePatch, "--patch", rec.patches[1].path, "--patch", userPatch,
      "--json", "--permission-mode", "read-only", "--approval-policy", "never",
      "--add-dir", "/abs/extra", "--session-id", "s1", "--", "do", "the task",
    ]);
    assert.equal(rec.patches[0].path, bundlePatch, "bundle patch first");
    assert.equal(rec.patches[2].path, userPatch, "user patch last");
    const { patch, rows } = generated(rec);
    assert.deepEqual(rows, [
      { id: "llm-pi-ai", config: { providers: { acme: {
        apiKeyEnv: "STEAK_TEST_KEY", api: "openai-completions", baseURL: "https://gw.example/v1",
        models: [{ id: "org/model-x", contextWindow: 12345, reasoningEfforts: { off: null, high: "high" } }], compat: { supportsDeveloperRole: false },
      } } } },
      { id: "agent-default-model", config: { provider: "acme", model: "org/model-x", reasoningEffort: "high" } },
      { id: "tool-bash", disabled: true },
      { id: "tool-pwsh", disabled: true },
      { id: "tool-jobs", disabled: true },
      { insert: [{ id: "steak-owned-paths", name: new URL(`file://${join(root, "plugins", "owned-paths.js")}`).href, config: { paths: ["/abs/owned"] } }] },
      { id: "steak-verify-after-edit", config: { command: "npm test" } },
    ]);
    assert.equal(existsSync(patch.path), false, "temp overlay removed after exit");
    assert.equal(existsSync(dirname(patch.path)), false, "temp dir removed after exit");
    assert.ok(existsSync(userPatch), "user files are never removed");
    for (const text of [result.stdout, result.stderr, ...rec.patches.map((p) => p.content)]) {
      assert.equal(text.includes("SECRET-SENTINEL-VALUE"), false, "key value must never appear");
    }
    assert.match(result.stdout, /"type":"session"/, "--json events pass through unchanged");
    assert.equal(rec.telemetry, "DISABLED", "telemetry defaults to DISABLED");
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("default run: bundle only, workspace-write, telemetry preserved when set", () => {
  const s = scratch();
  try {
    const result = run(["run", "hello"], s, { DSH_TELEMETRY_MODE: "FEEDBACK_ONLY" });
    assert.equal(result.status, 0, result.stderr);
    const [rec] = records(s);
    assert.deepEqual(rec.argv, ["headless", "--patch", bundlePatch, "--permission-mode", "workspace-write", "--approval-policy", "never", "--", "hello"]);
    assert.equal(rec.telemetry, "FEEDBACK_ONLY");
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("--stock omits the bundle patch; - reads the task from stdin", () => {
  const s = scratch();
  try {
    const result = run(["run", "--stock", "--model", "deepseek-official/deepseek-flash", "-"], s);
    assert.equal(result.status, 0, result.stderr);
    const [rec] = records(s);
    assert.equal(rec.argv.includes(bundlePatch), false);
    assert.equal(rec.argv.at(-1), "-");
    const { rows } = generated(rec);
    assert.deepEqual(rows, [{ id: "agent-default-model", config: { provider: "deepseek-official", model: "deepseek-flash" } }]);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("missing dsh exits 78 with the install hint (env override and PATH)", () => {
  const s = scratch();
  try {
    const bad = run(["run", "x"], s, { STEAK_DSH_DSH_BIN: join(s.dir, "no-such-dsh") });
    assert.equal(bad.status, 78);
    assert.match(bad.stderr, /npm i -g @deepseek-ai\/dsh/);
    assert.match(bad.stderr, /no-such-dsh/);
    const emptyPath = join(s.dir, "empty-path");
    const noPath = spawnSync(process.execPath, [launcher, "run", "x"], {
      cwd: s.dir, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PATH: emptyPath, STEAK_DSH_DSH_BIN: "", FAKE_DSH_RECORD: s.record },
    });
    assert.equal(noPath.status, 78);
    assert.match(noPath.stderr, /dsh was not found on PATH/);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("unset key env exits 2, names the variable, and never launches dsh", () => {
  const s = scratch();
  try {
    const env = { ...process.env };
    delete env.STEAK_TEST_KEY;
    const result = spawnSync(process.execPath, [launcher, "run", "--model", "acme/m", "--base-url", "https://gw.example/v1", "--api", "openai-completions", "--key-env", "STEAK_TEST_KEY", "x"], {
      cwd: s.dir, encoding: "utf8", timeout: 30_000,
      env: { ...env, STEAK_DSH_DSH_BIN: s.fake, FAKE_DSH_RECORD: s.record },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /STEAK_TEST_KEY is unset/);
    assert.equal(existsSync(s.record), false, "dsh must not run");
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("dsh exit code passes through", () => {
  const s = scratch();
  try {
    const result = run(["run", "x"], s, { FAKE_DSH_EXIT: "3" });
    assert.equal(result.status, 3);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("out-of-range dsh version warns once on stderr and continues", () => {
  const s = scratch();
  try {
    const result = run(["run", "x"], s, { FAKE_DSH_VERSION: "0.1.0" });
    assert.equal(result.status, 0, result.stderr);
    const warnings = result.stderr.split("\n").filter((line) => line.includes("warning"));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /0\.1\.0 is outside the supported range/);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("bad flags exit 2 with a named error", () => {
  const s = scratch();
  try {
    const cases = [
      [["run", "--bogus", "x"], /unknown option --bogus/],
      [["run", "--model", "no-slash", "x"], /--model must be <provider>\/<model-id>/],
      [["run", "--permission", "yolo", "x"], /--permission must be one of/],
      [["run", "--compat", "[1]", "--base-url", "https://g", "--api", "openai-completions", "--key-env", "K", "--model", "p/m", "x"], /--compat must be a JSON object/],
      [["run"], /run needs a task/],
      [["run", "--base-url", "https://g", "x"], /--base-url needs --model/],
      [["run", "--owned-path", "relative/dir", "x"], /--owned-path must be an absolute path/],
      [["run", "--api", "grpc", "x"], /--api must be one of/],
      [["run", "--patch", "/no/such/file.yml", "x"], /--patch file not found/],
      [["run", "--stock", "--verify", "npm test", "x"], /--verify cannot be combined with --stock: verify-after-edit is part of the bundle/],
      [["run", "--verify", "npm test", "--stock", "x"], /--verify cannot be combined with --stock/],
      [["run", "--effort", "high=max", "x"], /--effort high=max: the =<wire> spelling only applies to a declared route/],
      [["chat", "hello"], /chat takes no task/],
      [["wat"], /unknown command "wat"/],
    ];
    for (const [args, message] of cases) {
      const result = run(args, s);
      assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, message);
    }
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("SIGINT is forwarded to the dsh process group; overlay cleaned up on signal exit", async () => {
  const s = scratch();
  try {
    const child = spawn(process.execPath, [launcher, "run", "--model", "acme/m", "x"], {
      cwd: s.dir,
      env: { ...process.env, STEAK_DSH_DSH_BIN: s.fake, FAKE_DSH_RECORD: s.record, FAKE_DSH_SLEEP: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const deadline = Date.now() + 15_000;
    while (!existsSync(s.record) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(s.record), "fake dsh started");
    const overlayPath = records(s)[0].patches.find((p) => p.path.endsWith("overlay.yml")).path;
    child.kill("SIGINT");
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 42, `launcher exits with dsh's exit code after forwarding SIGINT (stderr: ${stderr})`);
    const all = records(s);
    assert.ok(all.some((r) => r.signal === "SIGINT"), "the dsh process group received SIGINT");
    assert.equal(existsSync(overlayPath), false, "temp overlay removed on signal exit");
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("install forwards to dsh plugin add; doctor reports dsh, bundle and plugins", () => {
  const s = scratch();
  try {
    const installed = run(["install"], s);
    assert.equal(installed.status, 0, installed.stderr);
    const [rec] = records(s);
    assert.deepEqual(rec.argv, ["plugin", "--profile", "headless", "add", root]);
    const doctor = run(["doctor"], s);
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.match(doctor.stdout, /dsh: .*fake-dsh\.mjs \(0\.2\.2-rc\.1\)/);
    assert.match(doctor.stdout, /bundle: .*cordis\.patch\.yml \(present\)/);
    for (const plugin of ["finish-guard.js", "owned-paths.js", "rules.js", "verify-after-edit.js"]) {
      assert.match(doctor.stdout, new RegExp(`plugin ${plugin.replace(".", "\\.")}: ok`));
    }
    const version = run(["--version"], s);
    assert.equal(version.status, 0);
    assert.match(version.stdout, /^\d+\.\d+\.\d+/);
    const help = run(["--help"], s);
    assert.equal(help.status, 0);
    for (const flag of ["--model", "--base-url", "--api", "--key-env", "--context-window", "--effort", "--compat", "--permission", "--add-dir", "--owned-path", "--no-shell", "--session-id", "--json", "--patch", "--stock", "--verify"]) {
      assert.ok(help.stdout.split("\n").some((line) => line.trim().startsWith(flag)), `help lists ${flag}`);
    }
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("withheld compat switches are left out with a note; --effort level=wire sets the wire spelling", () => {
  const s = scratch();
  try {
    const result = run([
      "run", "--model", "acme/m", "--base-url", "https://gw.example/v1", "--api", "openai-completions", "--key-env", "STEAK_TEST_KEY",
      "--compat", '{"supportsDeveloperRole":false,"sendSessionAffinityHeaders":true}', "--effort", "high=max", "task",
    ], s, { STEAK_TEST_KEY: "x" });
    assert.equal(result.status, 0, result.stderr);
    const { rows } = generated(records(s)[0]);
    const route = rows[0].config.providers.acme;
    assert.deepEqual(route.compat, { supportsDeveloperRole: false });
    assert.deepEqual(route.models[0].reasoningEfforts, { off: null, high: "max" });
    assert.equal(rows[1].config.reasoningEffort, "high");
    assert.match(result.stderr, /compat sendSessionAffinityHeaders cannot be set/);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("words after -- stay task text even when they look like dsh flags", () => {
  const s = scratch();
  try {
    const result = run(["run", "--", "--permission-mode", "danger-full-access", "fix", "it"], s);
    assert.equal(result.status, 0, result.stderr);
    const [rec] = records(s);
    assert.deepEqual(rec.argv, [
      "headless", "--patch", bundlePatch, "--permission-mode", "workspace-write", "--approval-policy", "never",
      "--", "--permission-mode", "danger-full-access", "fix", "it",
    ]);
    const at = rec.argv.indexOf("--permission-mode");
    assert.equal(rec.argv[at + 1], "workspace-write", "the task words did not override the real flag");
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("--effort without the =wire spelling still works on a catalog route", () => {
  const s = scratch();
  try {
    const result = run(["run", "--effort", "high", "x"], s);
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

async function waitGone(pid, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test("SIGHUP on run is forwarded to the dsh group; no child and no temp dir remain", async () => {
  const s = scratch();
  try {
    const child = spawn(process.execPath, [launcher, "run", "--model", "acme/m", "x"], {
      cwd: s.dir,
      env: { ...process.env, STEAK_DSH_DSH_BIN: s.fake, FAKE_DSH_RECORD: s.record, FAKE_DSH_SLEEP: "1", DSH_HOME: join(s.dir, "home") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const deadline = Date.now() + 15_000;
    while (!existsSync(s.record) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(s.record), "fake dsh started");
    const rec = records(s)[0];
    const overlayDir = dirname(rec.patches.find((p) => p.path.endsWith("overlay.yml")).path);
    child.kill("SIGHUP");
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 129, `128 + SIGHUP(1) after forwarding (stderr: ${stderr})`);
    assert.ok(await waitGone(rec.pid), "the dsh child is gone");
    assert.equal(existsSync(overlayDir), false, "temp overlay dir removed on SIGHUP");
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("SIGTERM on chat kills the running turn's group, removes the overlay and exits 143", async () => {
  const s = scratch();
  try {
    const child = spawn(process.execPath, [launcher, "chat", "--model", "acme/m"], {
      cwd: s.dir,
      env: { ...process.env, STEAK_DSH_DSH_BIN: s.fake, FAKE_DSH_RECORD: s.record, FAKE_DSH_SLEEP: "1", DSH_HOME: join(s.dir, "home") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.write("hello\n");
    const deadline = Date.now() + 15_000;
    while (!existsSync(s.record) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(s.record), "fake dsh started");
    const rec = records(s)[0];
    const overlayDir = dirname(rec.patches.find((p) => p.path.endsWith("overlay.yml")).path);
    child.kill("SIGTERM");
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 143, `128 + SIGTERM(15) (stderr: ${stderr})`);
    assert.ok(await waitGone(rec.pid), "the dsh child is gone");
    assert.equal(existsSync(overlayDir), false, "temp overlay dir removed on SIGTERM");
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("install: a dsh death by signal exits 128 + that signal, not always 143", () => {
  const s = scratch();
  try {
    const result = run(["install"], s, { FAKE_DSH_SELF_SIGNAL: "SIGHUP" });
    assert.equal(result.status, 129, `SIGHUP(1) must map to 129 (stderr: ${result.stderr})`);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("--long: the shipped profile patch is applied right after the bundle; the default run is unchanged", () => {
  const s = scratch();
  try {
    const long = run(["run", "--long", "--verify", "npm test", "a", "long", "task"], s);
    assert.equal(long.status, 0, long.stderr);
    const [rec] = records(s);
    assert.deepEqual(rec.argv.slice(0, 5), ["headless", "--patch", bundlePatch, "--patch", longPatch], "bundle first, then the profile");
    assert.equal(rec.patches[1].content, readFileSync(longPatch, "utf8"), "the shipped file is passed unchanged");
    const { patch, rows } = generated(rec);
    assert.equal(rec.patches.indexOf(patch), 2, "flag rows come after the profile, so --verify and --no-shell still apply");
    assert.deepEqual(rows, [{ id: "steak-verify-after-edit", config: { command: "npm test" } }]);
    assert.deepEqual(rec.argv.slice(-4), ["--", "a", "long", "task"]);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
  const d = scratch();
  try {
    const plain = run(["run", "hello"], d);
    assert.equal(plain.status, 0, plain.stderr);
    const [rec] = records(d);
    assert.deepEqual(rec.argv, ["headless", "--patch", bundlePatch, "--permission-mode", "workspace-write", "--approval-policy", "never", "--", "hello"],
      "without --long neither the profile nor a generated overlay is passed");
  } finally { rmSync(d.dir, { recursive: true, force: true }); }
});

test("the long-work profile only switches rows the bundle ships switched the other way (the guard is on in the bundle), and never goal or workflow tools", () => {
  const ids = (text, state) => new Set([...text.matchAll(new RegExp(`- id: (\\S+)\\n(?:\\s+name: \\S+\\n)?\\s+disabled: ${state}`, "g"))].map((m) => m[1]));
  const disabledByBundle = ids(readFileSync(bundlePatch, "utf8"), "true");
  const profile = readFileSync(longPatch, "utf8");
  const enabled = [...ids(profile, "false")];
  assert.deepEqual(enabled, ["tool-subagent", "tool-subagent-control", "tool-working-directory"]);
  for (const id of enabled) assert.ok(disabledByBundle.has(id), `${id} is off in the bundle, so the profile has something to turn on`);
  assert.equal(ids(profile, "true").size, 0, "the profile switches nothing off");
  for (const id of ["tool-goal", "goal-round-driver", "command-goal", "tool-workflow", "tool-subagent-fork", "session-title-llm"]) {
    assert.ok(disabledByBundle.has(id), `${id} stays off in the bundle`);
    assert.equal(new RegExp(`- id: ${id}\\b`).test(profile), false, `${id} is not part of the long-work profile`);
  }
  assert.match(profile, /- id: spill-policy\n\s+config:\n\s+maxInlineTokens: 12500\n/);
  assert.deepEqual([...profile.matchAll(/^- id: (\S+)/gm)].map((m) => m[1]),
    ["tool-subagent", "tool-subagent-control", "tool-working-directory", "spill-policy"], "exactly these four rows: the finish guard is on in the bundle");
  assert.deepEqual(buildRows({ long: true, noShell: true, ownedPaths: [], patches: [] }, root),
    [{ id: "tool-bash", disabled: true }, { id: "tool-pwsh", disabled: true }, { id: "tool-jobs", disabled: true }],
    "the profile adds no generated row; --no-shell still does");
});

test("--long with --stock is refused by name; chat accepts --long", async () => {
  const s = scratch();
  try {
    const bad = run(["run", "--stock", "--long", "x"], s);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--long cannot be combined with --stock/);
    assert.equal(existsSync(s.record), false, "dsh is never started on a refused flag set");
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
  const { parseOptions } = await import(join(root, "lib", "args.js"));
  assert.equal(parseOptions(["--long"], { allowTask: false }).options.long, true, "chat takes the flag too");
  assert.equal(parseOptions(["x"]).options.long, false, "off unless asked");
});
