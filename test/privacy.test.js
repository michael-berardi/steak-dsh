/** Privacy guards: no analytics SDK or endpoint in shipped code, and every launch path we control is quiet. */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileCacheDir, launchEnv, pruneCompileCache, quietEnv } from "../lib/dsh.js";
import { Controller, EXIT_LOG_LIMIT, pruneExitLogs } from "../lib/tui/session.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** Only known telemetry vendors and endpoints: model-provider OAuth/API URLs are not telemetry. */
const TELEMETRY = /posthog|mixpanel|amplitude|datadog|bugsnag|\bsentry\b|newrelic|rollbar|hotjar|fullstory|plausible|google-analytics|googletagmanager|gtag|@opentelemetry|opentelemetry-exporter|segment\.io|analytics\.js/i;

test("shipped source and the package manifest name no telemetry package or endpoint", () => {
  const shipped = [];
  for (const entry of pkg.files) {
    const path = join(root, entry);
    if (!existsSync(path) || /\.md$|LICENSE/.test(entry)) continue;
    const walk = (p) => {
      if (!statSync(p).isDirectory()) { shipped.push(p); return; }
      for (const item of readdirSync(p, { withFileTypes: true })) walk(join(p, item.name));
    };
    walk(path);
  }
  shipped.push(join(root, "package.json"));
  assert.ok(shipped.length > 30, "the shipped tree was found");
  for (const file of shipped) {
    const hit = TELEMETRY.exec(readFileSync(file, "utf8"));
    assert.equal(hit, null, `${file} names ${hit?.[0]}`);
  }
});

test("the launch environment cannot be talked into enabling telemetry", () => {
  const env = launchEnv({
    HOME: join(tmpdir(), "steak-dsh-privacy-home"),
    DSH_TELEMETRY_MODE: "FEEDBACK_ONLY",
    DO_NOT_TRACK: "0",
    STEAK_DSH_COMPILE_CACHE: "0",
  });
  assert.equal(env.DSH_TELEMETRY_MODE, "DISABLED");
  assert.equal(env.DO_NOT_TRACK, "1");
  const quiet = quietEnv({ DSH_TELEMETRY_MODE: "FEEDBACK_ONLY", ULTRATERM_UI_SESSION_ID: "host-only" });
  assert.equal(quiet.DSH_TELEMETRY_MODE, "DISABLED");
  assert.equal(quiet.DO_NOT_TRACK, "1");
  assert.equal(quiet.ULTRATERM_UI_SESSION_ID, undefined);
});

test("both installers disable analytics and dsh telemetry for the tools they start", () => {
  for (const file of ["scripts/install.sh", "scripts/install.ps1"]) {
    const source = readFileSync(join(root, file), "utf8");
    assert.match(source, /DO_NOT_TRACK\s*[=:]\s*'?1'?/, `${file} sets DO_NOT_TRACK`);
    assert.match(source, /DSH_TELEMETRY_MODE\s*[=:]\s*'?DISABLED'?/, `${file} disables dsh telemetry`);
  }
});

test("crash logs are kept private and bounded", () => {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-logs-"));
  try {
    const names = Array.from({ length: EXIT_LOG_LIMIT + 5 }, (_, i) => `harness-exit-2026-01-01T00-00-${String(i).padStart(2, "0")}-1.log`);
    for (const name of names) writeFileSync(join(dir, name), name);
    writeFileSync(join(dir, "unrelated.txt"), "keep");
    pruneExitLogs(dir);
    const left = readdirSync(dir).sort();
    assert.equal(left.length, EXIT_LOG_LIMIT + 1);
    assert.ok(names.slice(-EXIT_LOG_LIMIT).every((name) => left.includes(name)), "the newest logs stay");
    assert.ok(names.slice(0, 5).every((name) => !left.includes(name)), "the oldest logs go");
    assert.ok(left.includes("unrelated.txt"), "other files are untouched");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the compile cache drops stale and excess entries without following symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "steak-dsh-cache-prune-"));
  try {
    const cache = join(root, "cache");
    const version = join(cache, "v22-test");
    mkdirSync(version, { recursive: true });
    const names = ["old", "fresh-a", "fresh-b", "fresh-c"];
    const paths = names.map((name) => join(version, name));
    for (const path of paths) writeFileSync(path, "compiled module");
    const now = Date.now();
    const stamp = (path, ms) => { const date = new Date(ms); utimesSync(path, date, date); };
    stamp(paths[0], now - 31 * 24 * 60 * 60 * 1000);
    names.slice(1).forEach((_, i) => stamp(paths[i + 1], now - 60_000 + i * 1000));
    const outside = join(root, "outside");
    writeFileSync(outside, "keep");
    if (process.platform !== "win32") symlinkSync(outside, join(version, "link"));

    pruneCompileCache(cache, { now: () => now, maxFiles: 2 });
    const left = readdirSync(version).sort();
    assert.equal(left.includes("old"), false, "a file older than the retention window goes");
    assert.equal(left.includes("fresh-a"), false, "the oldest excess fresh file goes");
    assert.ok(left.includes("fresh-b") && left.includes("fresh-c"), "the newest files stay");
    assert.equal(readFileSync(outside, "utf8"), "keep", "the symlink target was never touched");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("launching prunes the private compile cache automatically", () => {
  const home = mkdtempSync(join(tmpdir(), "steak-dsh-cache-launch-"));
  try {
    const cache = join(home, ".cache", "steak-dsh", "compile-cache");
    const version = join(cache, "v22-test");
    mkdirSync(version, { recursive: true });
    const stale = join(version, "stale");
    writeFileSync(stale, "compiled module");
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    assert.equal(compileCacheDir({ HOME: home }), cache);
    assert.equal(existsSync(stale), false, "the launcher removed the stale entry");
    assert.equal(existsSync(cache), true, "the live cache folder stays usable");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a crash log tightens a log folder that already existed with loose permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-loose-"));
  try {
    const logDir = join(dir, "logs");
    mkdirSync(logDir);
    chmodSync(logDir, 0o755);
    const c = new Controller({ bin: "/nonexistent", args: [], options: {}, cwd: dir, env: {}, logDir });
    const file = c.writeExitLog({ code: 1, signal: null, how: "synthetic exit" });
    assert.ok(file, "the log was written");
    assert.equal(statSync(logDir).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("README Privacy stays short and true; PRIVACY.md carries the detail", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const section = readme.match(/^## Privacy\n([\s\S]*?)(?=^## )/m);
  assert.ok(section, "README has a Privacy section");
  const lines = section[1].split("\n").filter((line) => line.trim() !== "");
  assert.ok(lines.length >= 3 && lines.length <= 6, `README Privacy has ${lines.length} non-empty lines (3-6 allowed)`);
  const text = section[1];
  assert.match(text, /\[PRIVACY\.md\]\(PRIVACY\.md\)/, "links to PRIVACY.md");
  assert.match(text, /no telemetry/i);
  assert.match(text, /one anonymous GET a day/, "names the daily update check");
  assert.match(text, /STEAK_DSH_NO_UPDATE_CHECK=1/, "names the opt-out");

  const privacy = readFileSync(join(root, "PRIVACY.md"), "utf8");
  for (const detail of [
    "releases/latest", "steak-dsh-update-check", "at most once every 24 hours", "STEAK_DSH_NO_UPDATE_CHECK=1",
    '"checkAutomatically": false', "steak-dsh/update.json", "update.log", "256 KB", "newest **20** files",
    "**30 days**", "**4096 files**", "DSH_TELEMETRY_MODE=DISABLED", "DO_NOT_TRACK=1", "--disable-telemetry",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "or after 7 days",
  ]) assert.ok(privacy.includes(detail), `PRIVACY.md documents ${detail}`);
  for (const [file, body] of [["README.md", text], ["PRIVACY.md", privacy]]) {
    assert.doesNotMatch(body, /no (automatic |daily )?update (check|checker|prompt)s?\b/i, `${file} must not deny the update check`);
  }
});
