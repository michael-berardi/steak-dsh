#!/usr/bin/env node
// Runs the suite in two phases. Tests that assert real wall-clock budgets (a few hundred ms of silence, retries, backoff)
// run alone after everything else, so CPU load from other test files can never push them past their budgets. A file
// opts in with the line `// test-timing: serial` in its first 20 lines, optionally followed by a space and a reason. Every
// other file runs in parallel as before. A `// test-timing:` line this runner does not understand stops the run: a
// timing-sensitive file must never drift back into the parallel phase unnoticed (an exact-match check once missed
// `// test-timing: serial (reason)` and ran those files under full parallel load).
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const dir = new URL("../test/", import.meta.url).pathname;
const files = readdirSync(dir).filter((name) => name.endsWith(".test.js")).sort();
const timing = (name) => readFileSync(join(dir, name), "utf8").split("\n").slice(0, 20).map((line) => line.trim()).filter((line) => /^\/\/\s*test-timing\b/.test(line));
for (const name of files) {
  const unknown = timing(name).filter((line) => !/^\/\/ test-timing: serial(\s|$)/.test(line));
  if (unknown.length) { console.error(`run-tests: ${name}: unrecognised ${JSON.stringify(unknown[0])}; use "// test-timing: serial" (optionally followed by a reason)`); process.exit(2); }
}
const serial = files.filter((name) => timing(name).length > 0);
const parallel = files.filter((name) => !serial.includes(name));
const run = (names, extra) => names.length ? spawnSync(process.execPath, ["--test", ...extra, ...names.map((name) => join(dir, name))], { stdio: "inherit" }).status ?? 1 : 0;
const first = run(parallel, []);
const second = run(serial, ["--test-concurrency=1"]);
process.exit(first || second);
