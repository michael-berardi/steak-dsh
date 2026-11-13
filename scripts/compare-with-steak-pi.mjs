#!/usr/bin/env node
// Compares the models Steak Pi and Steak DSH offer on the two login-backed routes (claude-code, openai-codex).
// Read-only: it runs `steak-pi --list-models` and `steak-dsh models --json` and reports the ids only one side has.
//
// Usage: node scripts/compare-with-steak-pi.mjs [--steak-pi <command>] [--steak-dsh <command>] [--json]
// Exit: 0 the lists match, 1 they differ, 2 a command failed or a route did not answer (the reason is printed).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROVIDERS = ["claude-code", "openai-codex"];

/** `provider/model-id` entries for the compared providers, from Steak Pi's `--list-models` table. */
export function parseSteakPiList(text, providers = PROVIDERS) {
  const found = new Set();
  for (const line of text.split("\n")) {
    const [provider, model] = line.trim().split(/\s+/u);
    if (model && providers.includes(provider)) found.add(`${provider}/${model}`);
  }
  return [...found].sort();
}

/** Per provider: what both sides list, and what only one side lists. */
export function compareLists(steakPi, steakDsh, providers = PROVIDERS) {
  const report = {};
  for (const provider of providers) {
    const mine = (list) => list.filter((entry) => entry.startsWith(`${provider}/`));
    const pi = new Set(mine(steakPi));
    const dsh = new Set(mine(steakDsh));
    report[provider] = {
      both: [...pi].filter((entry) => dsh.has(entry)).sort(),
      onlySteakPi: [...pi].filter((entry) => !dsh.has(entry)).sort(),
      onlySteakDsh: [...dsh].filter((entry) => !pi.has(entry)).sort(),
    };
  }
  return report;
}

export const same = (report) => Object.values(report).every((row) => row.onlySteakPi.length === 0 && row.onlySteakDsh.length === 0);

export function renderReport(report) {
  const lines = [];
  for (const [provider, row] of Object.entries(report)) {
    lines.push(`${provider}: ${row.both.length} in both, ${row.onlySteakPi.length} only in Steak Pi, ${row.onlySteakDsh.length} only in Steak DSH`);
    for (const entry of row.onlySteakPi) lines.push(`  only Steak Pi:  ${entry}`);
    for (const entry of row.onlySteakDsh) lines.push(`  only Steak DSH: ${entry}`);
  }
  lines.push(same(report) ? "The two lists are the same." : "The two lists differ.");
  return `${lines.join("\n")}\n`;
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw new Error(`could not run ${command}: ${result.error.message}`);
  return result;
}

function main(argv) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  let steakPi = ["steak-pi"];
  let steakDsh = [process.execPath, join(root, "bin", "steak-dsh")];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") json = true;
    else if (argv[i] === "--steak-pi" && argv[i + 1]) steakPi = [argv[++i]];
    else if (argv[i] === "--steak-dsh" && argv[i + 1]) steakDsh = [argv[++i]];
    else { process.stderr.write(`compare-with-steak-pi: unknown option ${argv[i]}\n`); return 2; }
  }
  const pi = capture(steakPi[0], [...steakPi.slice(1), "--list-models"]);
  if (pi.status !== 0) { process.stderr.write(`compare-with-steak-pi: ${steakPi[0]} --list-models exited ${pi.status}: ${pi.stderr.trim().slice(-300)}\n`); return 2; }
  const dsh = capture(steakDsh[0], [...steakDsh.slice(1), "models", "--json"]);
  let listed;
  try {
    listed = JSON.parse(dsh.stdout);
  } catch {
    process.stderr.write(`compare-with-steak-pi: steak-dsh models --json exited ${dsh.status} without a list: ${dsh.stderr.trim().slice(-300)}\n`);
    return 2;
  }
  const report = compareLists(parseSteakPiList(pi.stdout), listed.models);
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report));
  if (dsh.status !== 0) { process.stderr.write(dsh.stderr); return 2; }
  return same(report) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`compare-with-steak-pi: ${error.message}\n`);
    process.exit(2);
  }
}
