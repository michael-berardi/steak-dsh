import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = readdirSync(join(root, "lib", "tui")).map((f) => join("lib", "tui", f));

test("the TUI imports only Node built-ins or its own files: no dependencies", () => {
  assert.ok(files.length >= 10);
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
      assert.match(match[1], /^(node:|\.\.?\/)/, `${file} imports ${match[1]}`);
    }
  }
});

test("shipped TUI code names no model, provider, fallback chain or person", () => {
  const banned = /qwen|deepseek-v|deepseek-official|openrouter|claude|gpt-|opus|sonnet|haiku|anthropic|openai|fallback|libertydesign|berardi|mike@/i;
  for (const file of [...files, join("lib", "tui", "..", "..", "long.patch.yml")]) {
    const source = readFileSync(join(root, file), "utf8");
    assert.equal(banned.exec(source), null, `${file} names ${banned.exec(source)?.[0]}`);
  }
});
