import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
  for (const entry of ["plugins", "claude-code", "codex", "cordis.patch.yml", "long.patch.yml"]) assert.ok(pkg.files.includes(entry), `${entry} is not shipped`);
  assert.ok(existsSync(join(root, "long.patch.yml")), "long.patch.yml missing");
});

test("plugins import nothing outside Node, so they load from any profile", () => {
  for (const file of readdirSync(join(root, "plugins"))) {
    const source = readFileSync(join(root, "plugins", file), "utf8");
    for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
      // The one allowed relative import: the entry of the CLI-backed route, which has its own folder.
      if (file === "cc-route.js" && match[1] === "../claude-code/plugin.js") continue;
      if (file === "codex-route.js" && match[1] === "../codex/plugin.js") continue;
      assert.match(match[1], /^node:/, `${file} imports ${match[1]}`);
    }
  }
});

test("shipped code names no model or provider", () => {
  const banned = /qwen|deepseek-v|openrouter|claude|gpt-|opus|sonnet|haiku|anthropic|openai/i;
  for (const file of [...readdirSync(join(root, "plugins")).map((f) => join("plugins", f)), "cordis.patch.yml", "long.patch.yml"]) {
    // The entry shim may name the route's folder, nothing else.
    const source = readFileSync(join(root, file), "utf8").replaceAll("../claude-code/plugin.js", "");
    assert.doesNotMatch(source, /chatgpt|responses endpoint of/i, `${file} names a vendor`);
    assert.equal(banned.exec(source), null, `${file} names ${banned.exec(source)?.[0]}`);
  }
});

test("the patch row for the route names only its neutral entry file", () => {
  const patch = readFileSync(join(root, "cordis.patch.yml"), "utf8");
  assert.match(patch, /id: steak-cc-route\n\s+name: \.\/plugins\/cc-route\.js/);
  assert.match(patch, /id: steak-codex-route\n\s+name: \.\/plugins\/codex-route\.js\n\s+config: \{\}/, "the row carries no model, endpoint or login setting");
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

test("no shipped file lists models: the routes ask their own source at runtime", () => {
  // A model id is a vendor word followed by a version. Docs and tests may show examples; shipped code may not.
  const modelId = /\b(?:gpt|claude|qwen|deepseek|gemini|grok|glm|kimi)-[a-z0-9][a-z0-9.-]*\d|\bo[134]-(?:mini|pro|preview)\b/i;
  const shipped = [];
  for (const entry of pkg.files) {
    const path = join(root, entry);
    if (!existsSync(path) || /\.md$|LICENSE/.test(entry)) continue;
    const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).forEach((f) => walk(join(p, f))) : shipped.push(p));
    walk(path);
  }
  assert.ok(shipped.length > 30);
  for (const file of shipped.filter((f) => /\.(m?js|yml|json)$/.test(f) || !/\./.test(f.split("/").pop()))) {
    const hit = modelId.exec(readFileSync(file, "utf8"));
    assert.equal(hit, null, `${file} names the model ${hit?.[0]}`);
  }
});
