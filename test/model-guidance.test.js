import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, guidanceFor, loadRules, parseRules } from "../plugins/model-guidance.js";

const RULES = [{ match: "^example/fast-", text: "Return the named JSON shape." }, { match: "flash", text: "Second line." }];
const home = (content) => {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-guidance-"));
  if (content !== undefined) writeFileSync(join(dir, "steak-dsh.json"), typeof content === "string" ? content : JSON.stringify(content));
  return dir;
};

test("no rule ships: no file and no key mean no section", () => {
  const dir = home();
  try {
    assert.deepEqual(loadRules({}, dir), { rules: [], errors: [] });
    const made = [];
    const saved = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try { apply({ effect: (fn) => fn(), systemPrompt: { section: (s) => made.push(s) } }, {}); } finally {
      if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved;
    }
    assert.equal(made.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rules from steak-dsh.json match the step's provider/model, in order", () => {
  const dir = home({ modelGuidance: RULES });
  try {
    const { rules, errors } = loadRules({}, dir);
    assert.deepEqual(errors, []);
    assert.equal(guidanceFor({ provider: "example", model: "fast-flash" }, rules), "Return the named JSON shape.\nSecond line.");
    assert.equal(guidanceFor({ provider: "EXAMPLE", model: "fast-1" }, rules), "Return the named JSON shape.");
    assert.equal(guidanceFor({ provider: "other", model: "slow" }, rules), "");
    assert.equal(guidanceFor(undefined, rules), "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("one section whose text follows the step's model selection; row config wins over the file", () => {
  const made = [];
  apply({ effect: (fn) => fn(), systemPrompt: { section: (s) => made.push(s) } }, { rules: RULES });
  assert.equal(made.length, 1);
  assert.equal(made[0].name, "steak:model-guidance");
  assert.equal(made[0].interpolate, false);
  assert.equal(made[0].text({ modelSelection: { provider: "example", model: "fast-1" } }), "Return the named JSON shape.");
  assert.equal(made[0].text({ modelSelection: { provider: "other", model: "slow" } }), "");
});

test("bad rules are named and skipped; a bad file is named", () => {
  const { rules, errors } = parseRules([{ match: "(", text: "x" }, { match: "", text: "x" }, { match: "a", text: "" }, 3, { match: "a", text: "x".repeat(601) }, RULES[0]]);
  assert.equal(rules.length, 1);
  assert.equal(errors.length, 5);
  assert.match(errors[0], /modelGuidance\[0\]\.match is not a valid pattern/);
  assert.match(parseRules({}).errors[0], /must be a list/);
  const dir = home("{ nope");
  try { assert.match(loadRules({}, dir).errors[0], /is not valid JSON/); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("switched off by environment or row config", () => {
  const made = [];
  const ctx = { effect: (fn) => fn(), systemPrompt: { section: (s) => made.push(s) } };
  process.env.STEAK_DSH_MODEL_GUIDANCE = "off";
  try { apply(ctx, { rules: RULES }); } finally { delete process.env.STEAK_DSH_MODEL_GUIDANCE; }
  apply(ctx, { rules: RULES, enabled: false });
  assert.equal(made.length, 0);
});
