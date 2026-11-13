// `steak-dsh models` and the comparison script, with fake sources: no CLI, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSources, modelsCommand } from "../lib/models.js";
import { compareLists, parseSteakPiList, renderReport, same } from "../scripts/compare-with-steak-pi.mjs";

const root = join(import.meta.dirname, "..");
const fail = (code, message) => () => Promise.reject(Object.assign(new Error(message), { code }));

async function models(argv, sources) {
  let out = "";
  let err = "";
  const code = await modelsCommand(argv, { sources, out: (t) => { out += t; }, err: (t) => { err += t; } });
  return { code, out, err };
}

test("models: prints provider/model-id for every route, sorted, exactly what each source reports", async () => {
  const sources = { "route-b": async () => ["z-row", "a-row", "a-row"], "route-a": async () => ["only"] };
  const { code, out, err } = await models([], sources);
  assert.equal(code, 0);
  assert.equal(out, "route-b/a-row\nroute-b/z-row\nroute-a/only\n");
  assert.equal(err, "");
});

test("models: a route that does not answer is named on stderr with its code, the others still print, and the exit is 1", async () => {
  const sources = { "route-a": async () => ["only"], "route-b": fail("ROUTE_NOT_LOGGED_IN", "no login found") };
  const { code, out, err } = await models([], sources);
  assert.equal(code, 1);
  assert.equal(out, "route-a/only\n");
  assert.equal(err, "steak-dsh: route-b: no models: ROUTE_NOT_LOGGED_IN: no login found\n");
});

test("models: --json carries the list and each route's count or error; --provider narrows; bad options are usage errors", async () => {
  const sources = { "route-a": async () => ["only"], "route-b": fail("X", "why") };
  const all = await models(["--json"], sources);
  assert.deepEqual(JSON.parse(all.out), { models: ["route-a/only"], routes: { "route-a": { models: 1 }, "route-b": { models: 0, error: { code: "X", message: "why" } } } });
  const one = await models(["--provider", "route-a"], sources);
  assert.equal(one.code, 0);
  assert.equal(one.out, "route-a/only\n");
  await assert.rejects(models(["--provider", "nope"], sources), /--provider must be one of route-a, route-b/);
  await assert.rejects(models(["--wat"], sources), /unknown models option --wat/);
});

test("models: the two built-in sources are the bundle's two login-backed routes", () => {
  assert.deepEqual(Object.keys(defaultSources({})), ["claude-code", "openai-codex"]);
});

test("models: on a machine with neither login the command names both causes and prints no model", () => {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-models-test-"));
  try {
    const result = spawnSync(process.execPath, [join(root, "bin", "steak-dsh"), "models"], {
      encoding: "utf8", timeout: 60_000,
      env: { PATH: dir, HOME: dir, STEAK_DSH_CODEX_HOME: join(dir, "none"), STEAK_DSH_CLAUDE_CODE_COMMAND: join(dir, "missing-cli") },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /claude-code: no models: CLAUDE_CODE_NOT_READY: /);
    assert.match(result.stderr, /openai-codex: no models: CODEX_NOT_LOGGED_IN: /);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const TABLE = `provider       model            context  max-out  thinking  images
claude-code    row-one          1M       128K     yes       yes
claude-code    default          1M       128K     yes       yes
openai-codex   row-two          272K     128K     yes       yes
other-route    vendor/row-two   400K     128K     yes       yes
`;

test("compare: Steak Pi's table is read for the two routes only, and differences are reported per route", () => {
  const pi = parseSteakPiList(TABLE);
  assert.deepEqual(pi, ["claude-code/default", "claude-code/row-one", "openai-codex/row-two"]);
  const equal = compareLists(pi, [...pi]);
  assert.equal(same(equal), true);
  assert.match(renderReport(equal), /The two lists are the same\.\n$/);
  const report = compareLists(pi, ["claude-code/default", "claude-code/row-new", "openai-codex/row-two"]);
  assert.deepEqual(report["claude-code"], { both: ["claude-code/default"], onlySteakPi: ["claude-code/row-one"], onlySteakDsh: ["claude-code/row-new"] });
  assert.equal(same(report), false);
  assert.match(renderReport(report), /only Steak Pi: {2}claude-code\/row-one\n {2}only Steak DSH: claude-code\/row-new/);
});

test("compare: the script runs both commands and exits 0 when the lists match, 1 when they differ, 2 when one fails", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-compare-test-"));
  try {
    const script = (name, body) => { const path = join(dir, name); writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); return path; };
    const pi = script("pi", `cat <<'T'\n${TABLE}T`);
    const list = (models) => script(`dsh-${models.length}`, `cat <<'T'\n${JSON.stringify({ models, routes: {} })}\nT`);
    const run = (dsh) => spawnSync(process.execPath, [join(root, "scripts", "compare-with-steak-pi.mjs"), "--steak-pi", pi, "--steak-dsh", dsh], { encoding: "utf8", timeout: 60_000 });
    const match = run(list(["claude-code/default", "claude-code/row-one", "openai-codex/row-two"]));
    assert.equal(match.status, 0, match.stderr);
    const differ = run(list(["claude-code/default", "openai-codex/row-two"]));
    assert.equal(differ.status, 1);
    assert.match(differ.stdout, /claude-code: 1 in both, 1 only in Steak Pi, 0 only in Steak DSH/);
    const broken = run(script("dsh-broken", "echo 'steak-dsh: boom' >&2; exit 1"));
    assert.equal(broken.status, 2);
    assert.match(broken.stderr, /without a list: steak-dsh: boom/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
