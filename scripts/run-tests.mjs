#!/usr/bin/env node
// Runs the suite in two phases. Tests that assert real wall-clock budgets (a few hundred ms of silence, retries, backoff)
// run alone after everything else, so CPU load from other test files can never push them past their budgets. A file
// opts in with the line `// test-timing: serial` in its first 20 lines. Every other file runs in parallel as before.
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const dir = new URL("../test/", import.meta.url).pathname;
const files = readdirSync(dir).filter((name) => name.endsWith(".test.js")).sort();
const serial = files.filter((name) => readFileSync(join(dir, name), "utf8").split("\n").slice(0, 20).some((line) => line.trim() === "// test-timing: serial"));
const parallel = files.filter((name) => !serial.includes(name));
const run = (names, extra) => names.length ? spawnSync(process.execPath, ["--test", ...extra, ...names.map((name) => join(dir, name))], { stdio: "inherit" }).status ?? 1 : 0;
const first = run(parallel, []);
const second = run(serial, ["--test-concurrency=1"]);
process.exit(first || second);
