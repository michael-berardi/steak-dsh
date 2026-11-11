import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apply as rules, DEFAULT_RULES } from "../plugins/rules.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("the package is a dsh bundle and ships every file its patch names", () => {
  assert.equal(pkg.dsh.manifestVersion, 1);
  const patch = readFileSync(join(root, pkg.dsh.bundle.patch), "utf8");
  const names = [...patch.matchAll(/name:\s*(\.\/\S+)/g)].map((m) => m[1]);
  assert.ok(names.length >= 3);
  for (const name of names) assert.ok(existsSync(join(root, name)), `${name} missing`);
  for (const entry of ["plugins", "cordis.patch.yml"]) assert.ok(pkg.files.includes(entry));
});

test("plugins import nothing outside Node, so they load from any profile", () => {
  for (const file of readdirSync(join(root, "plugins"))) {
    const source = readFileSync(join(root, "plugins", file), "utf8");
    for (const match of source.matchAll(/from\s+"([^"]+)"/g)) assert.match(match[1], /^node:/, `${file} imports ${match[1]}`);
  }
});

test("shipped code names no model or provider", () => {
  const banned = /qwen|deepseek-v|openrouter|claude|gpt-|opus|sonnet|haiku|anthropic|openai/i;
  for (const file of [...readdirSync(join(root, "plugins")).map((f) => join("plugins", f)), "cordis.patch.yml"]) {
    const source = readFileSync(join(root, file), "utf8");
    assert.equal(banned.exec(source), null, `${file} names ${banned.exec(source)?.[0]}`);
  }
});

test("rules register one section and can be replaced or emptied", () => {
  const made = [];
  const ctx = { effect: (fn) => fn(), systemPrompt: { section: (s) => made.push(s) } };
  rules(ctx, {});
  assert.equal(made[0].text, DEFAULT_RULES);
  rules(ctx, { text: "Only this." });
  assert.equal(made[1].text, "Only this.");
  rules(ctx, { text: "" });
  assert.equal(made.length, 2);
});
