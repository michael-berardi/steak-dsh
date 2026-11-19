import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(root, "bin", "steak-dsh");
const { parseOptions } = await import(join(root, "lib", "args.js"));

const FAKE_DSH = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv[0] === "--version") { process.stdout.write("0.2.2-rc.1\\n"); process.exit(0); }
const patches = argv.flatMap((a, i) => (a === "--patch" ? [readFileSync(argv[i + 1], "utf8")] : []));
appendFileSync(process.env.FAKE_DSH_RECORD, JSON.stringify({ argv, patches, key: process.env.STEAK_DSH_LOCAL_KEY }) + "\\n");
process.stdout.write(JSON.stringify({ type: "final", sessionId: "s", reason: { kind: "completed" }, text: "ok" }) + "\\n");
process.exit(Number(process.env.FAKE_DSH_EXIT ?? 0));
`;

// Records each call with its argv and the parent pid (the lease holder in the real tool).
const FAKE_PI = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_PI_RECORD, JSON.stringify({ argv, ppid: process.ppid }) + "\\n");
if (argv[1] === "ensure") {
  if (process.env.FAKE_PI_REFUSE) { process.stderr.write(process.env.FAKE_PI_REFUSE + "\\n"); process.exit(1); }
  process.stdout.write(process.env.FAKE_PI_READY ?? ("ready: local/" + argv[2] + " at http://127.0.0.1:8123/v1 (pid 1, ctx 4096)\\n"));
}
if (argv[1] === "release" && process.env.FAKE_PI_RELEASE_FAIL) { process.stderr.write("release broke\\n"); process.exit(1); }
`;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-local-test-"));
  const dsh = join(dir, "fake-dsh.mjs");
  const pi = join(dir, "fake-steak-pi.mjs");
  writeFileSync(dsh, FAKE_DSH, { mode: 0o755 });
  writeFileSync(pi, FAKE_PI, { mode: 0o755 });
  const agent = join(dir, "agent");
  mkdirSync(join(agent, "local", "profiles"), { recursive: true });
  return { dir, dsh, pi, agent, dshRecord: join(dir, "dsh.jsonl"), piRecord: join(dir, "pi.jsonl") };
}

function run(args, s, env = {}) {
  return spawnSync(process.execPath, [launcher, ...args], {
    cwd: s.dir, encoding: "utf8", timeout: 30_000,
    env: {
      ...process.env, STEAK_DSH_DSH_BIN: s.dsh, STEAK_DSH_STEAK_PI: s.pi, FAKE_DSH_RECORD: s.dshRecord, FAKE_PI_RECORD: s.piRecord,
      DSH_HOME: join(s.dir, "home"), PI_CODING_AGENT_DIR: s.agent, ...env,
    },
  });
}
const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const rowsOf = (rec) => JSON.parse(rec.patches.at(-1));

test("ready path: ensure, declared local provider with parsed baseURL, profile ctx, placeholder key, then release", () => {
  const s = scratch();
  writeFileSync(join(s.agent, "local", "profiles", "my-model.json"), JSON.stringify({ ctx: 32768 }));
  const r = run(["run", "--model", "local/my-model", "task"], s);
  assert.equal(r.status, 0, r.stderr);
  const pi = lines(s.piRecord);
  assert.deepEqual(pi.map((c) => c.argv), [["local", "ensure", "my-model"], ["local", "release", "my-model"]]);
  assert.ok(pi.every((c) => c.ppid !== process.pid && c.ppid > 0));
  const rec = lines(s.dshRecord)[0];
  const rows = rowsOf(rec);
  const provider = rows.find((row) => row.id === "llm-pi-ai").config.providers.local;
  assert.equal(provider.baseURL, "http://127.0.0.1:8123/v1");
  assert.equal(provider.api, "openai-completions");
  assert.equal(provider.apiKeyEnv, "STEAK_DSH_LOCAL_KEY");
  assert.deepEqual(provider.models, [{ id: "my-model", contextWindow: 32768 }]);
  assert.deepEqual(rows.find((row) => row.id === "agent-default-model").config, { provider: "local", model: "my-model" });
  assert.equal(rec.key, "local-no-key");
});

test("--context-window wins over the profile; a missing profile is fine", () => {
  const s = scratch();
  writeFileSync(join(s.agent, "local", "profiles", "my-model.json"), JSON.stringify({ ctx: 32768 }));
  assert.equal(run(["run", "--model", "local/my-model", "--context-window", "1000", "t"], s).status, 0);
  assert.equal(rowsOf(lines(s.dshRecord)[0]).find((r) => r.id === "llm-pi-ai").config.providers.local.models[0].contextWindow, 1000);
  const s2 = scratch();
  assert.equal(run(["run", "--model", "local/other", "t"], s2).status, 0);
  assert.deepEqual(rowsOf(lines(s2.dshRecord)[0]).find((r) => r.id === "llm-pi-ai").config.providers.local.models, [{ id: "other" }]);
});

test("refusal: the tool's stderr line passes through, exit 2, dsh never started, no release", () => {
  const s = scratch();
  const message = "steak-pi local: REFUSED (on-hold): the local model is on hold";
  const r = run(["run", "--model", "local/my-model", "t"], s, { FAKE_PI_REFUSE: message });
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim(), message);
  assert.equal(existsSync(s.dshRecord), false);
  assert.deepEqual(lines(s.piRecord).map((c) => c.argv[1]), ["ensure"]);
});

test("missing steak-pi: a named message about the local manager and --base-url", () => {
  const s = scratch();
  for (const env of [{ STEAK_DSH_STEAK_PI: join(s.dir, "nope") }, { STEAK_DSH_STEAK_PI: "", PATH: dirname(process.execPath) }]) {
    const r = run(["run", "--model", "local/my-model", "t"], s, env);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /needs Steak Pi's local manager \(`steak-pi local`\)/);
    assert.match(r.stderr, /--base-url/);
  }
  assert.equal(existsSync(s.dshRecord), false);
});

test("a failing run still releases and keeps its own exit code; a failed release is reported, not hiding it", () => {
  const s = scratch();
  const r = run(["run", "--model", "local/my-model", "t"], s, { FAKE_DSH_EXIT: "7", FAKE_PI_RELEASE_FAIL: "1" });
  assert.equal(r.status, 7);
  assert.match(r.stderr, /could not release the local model lease for my-model: release broke/);
  assert.deepEqual(lines(s.piRecord).map((c) => c.argv[1]), ["ensure", "release"]);
});

test("an unparseable ensure answer is named and the lease is released", () => {
  const s = scratch();
  const r = run(["run", "--model", "local/my-model", "t"], s, { FAKE_PI_READY: "hello\n" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /printed no "ready: local\/my-model at <baseUrl>" line/);
  assert.equal(existsSync(s.dshRecord), false);
  assert.deepEqual(lines(s.piRecord).map((c) => c.argv[1]), ["ensure", "release"]);
});

test("an ensure answer for another model, or for a server not on this machine, is refused and the lease released", () => {
  for (const [ready, pattern] of [
    ["ready: local/other at http://127.0.0.1:8123/v1 (started)\n", /answered for local\/other, not local\/my-model/],
    ["ready: local/my-model at https://example.com/v1 (started)\n", /not a server on this machine/],
  ]) {
    const s = scratch();
    const r = run(["run", "--model", "local/my-model", "t"], s, { FAKE_PI_READY: ready });
    assert.equal(r.status, 2);
    assert.match(r.stderr, pattern);
    assert.equal(existsSync(s.dshRecord), false);
    assert.deepEqual(lines(s.piRecord).map((c) => c.argv[1]), ["ensure", "release"]);
  }
});

test("flag conflicts: --base-url, --api, --key-env are refused with local/...", () => {
  for (const extra of [["--base-url", "http://x/v1", "--api", "openai-completions", "--key-env", "K"], ["--api", "openai-completions"], ["--key-env", "K"]]) {
    assert.throws(() => parseOptions(["--model", "local/my-model", ...extra, "t"]), /cannot be used with --model local\/\.\.\./);
  }
  const { options } = parseOptions(["--model", "local/my-model", "--context-window", "100", "--stock", "t"]);
  assert.equal(options.contextWindow, 100);
  assert.equal(options.stock, true);
});

test("other routes never run steak-pi", () => {
  const s = scratch();
  const r = run(["run", "--model", "gw/x", "--base-url", "http://h/v1", "--api", "openai-completions", "--key-env", "PATH", "t"], s);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(s.piRecord), false);
});

test("models lists local/<id> per profile file only when profiles exist; doctor reports availability", async () => {
  const s = scratch();
  const { defaultSources } = await import(join(root, "lib", "models.js"));
  const env = { PI_CODING_AGENT_DIR: s.agent };
  assert.equal("local" in defaultSources(env), false);
  writeFileSync(join(s.agent, "local", "profiles", "my-model.json"), "{}");
  assert.deepEqual(await defaultSources(env).local(), ["my-model"]);
  const { doctorLine } = await import(join(root, "lib", "local.js"));
  assert.match(doctorLine({ ...env, STEAK_DSH_STEAK_PI: s.pi }), /available; profiles: 1/);
  assert.match(doctorLine({ ...env, STEAK_DSH_STEAK_PI: "", PATH: "" }), /not found/);
});
