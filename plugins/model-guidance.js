/**
 * Per-model guidance: short system-prompt lines the operator attaches to models whose "provider/model" matches a
 * pattern. The bundle ships no rule and names no model; rules come from this row's config or from
 * `$DSH_HOME/steak-dsh.json` (default `~/.dsh/steak-dsh.json`):
 *
 *   { "modelGuidance": [{ "match": "<regular expression over provider/model>", "text": "<one or two sentences>" }] }
 *
 * The section reads the step's own model selection, so a fallback or a model switch gets that model's lines. A bad rule
 * is reported once on stderr with its position and skipped. STEAK_DSH_MODEL_GUIDANCE=off leaves every rule out.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "steak-model-guidance";
export const inject = ["systemPrompt"];
export const MAX_TEXT = 600;

const dshHome = () => ((process.env.DSH_HOME ?? "").trim() || join(homedir(), ".dsh"));

export function parseRules(raw) {
  const rules = [];
  const errors = [];
  if (raw === undefined || raw === null) return { rules, errors };
  if (!Array.isArray(raw)) return { rules, errors: ["modelGuidance must be a list of { match, text } rules"] };
  raw.forEach((rule, i) => {
    const at = `modelGuidance[${i}]`;
    if (!rule || typeof rule !== "object") return void errors.push(`${at} is not an object`);
    if (typeof rule.match !== "string" || !rule.match.trim()) return void errors.push(`${at}.match must be a non-empty pattern`);
    if (typeof rule.text !== "string" || !rule.text.trim()) return void errors.push(`${at}.text must be non-empty`);
    if (rule.text.trim().length > MAX_TEXT) return void errors.push(`${at}.text is longer than ${MAX_TEXT} characters`);
    try {
      rules.push({ match: new RegExp(rule.match, "i"), text: rule.text.trim() });
    } catch (error) {
      errors.push(`${at}.match is not a valid pattern: ${error?.message ?? error}`);
    }
  });
  return { rules, errors };
}

export function loadRules(config = {}, home = dshHome()) {
  if (Array.isArray(config.rules)) return parseRules(config.rules);
  let text;
  try {
    text = readFileSync(join(home, "steak-dsh.json"), "utf8");
  } catch (error) {
    return { rules: [], errors: error?.code === "ENOENT" ? [] : [`${join(home, "steak-dsh.json")}: ${error?.message ?? error}`] };
  }
  try {
    return parseRules(JSON.parse(text)?.modelGuidance);
  } catch (error) {
    return { rules: [], errors: [`${join(home, "steak-dsh.json")} is not valid JSON: ${error?.message ?? error}`] };
  }
}

export function guidanceFor(selection, rules) {
  if (!selection?.model) return "";
  const ref = `${selection.provider ?? ""}/${selection.model}`;
  return rules.filter((rule) => rule.match.test(ref)).map((rule) => rule.text).join("\n");
}

export function apply(ctx, config = {}) {
  if (["0", "false", "off", "no"].includes(String(process.env.STEAK_DSH_MODEL_GUIDANCE ?? "").trim().toLowerCase())) return;
  if (config.enabled === false) return;
  const { rules, errors } = loadRules(config);
  if (errors.length) process.stderr.write(`steak-dsh: model guidance: ${errors.join("; ")}\n`);
  if (!rules.length) return;
  ctx.effect(() => ctx.systemPrompt.section({
    name: "steak:model-guidance",
    order: Number.isFinite(config.order) ? config.order : 9100,
    interpolate: false,
    text: (context) => guidanceFor(context?.modelSelection, rules),
  }), "steak-model-guidance.section()");
}
