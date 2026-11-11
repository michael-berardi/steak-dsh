/**
 * Working rules: one short system-prompt section. The text is config, so a deployment can replace or empty it.
 */
export const name = "steak-rules";
export const inject = ["systemPrompt"];

export const DEFAULT_RULES = [
  "Work rules:",
  "- Be economical with steps. Send independent tool calls together in one step (several reads, or several checks, at once) instead of one per step.",
  "- Gather context once. Do not re-read a file you just read or wrote, and do not list a directory twice.",
  "- For large files and logs, search or compute with a command instead of reading the whole file.",
  "- After a change, check it once: run the project's tests or check script when one exists, otherwise run the changed code. If it fails, fix it and run again. Report failures as failures.",
  "- A request with several parts is done only when every part is done. Change only what was asked.",
  "- Final reply: a few short lines saying what changed and how you checked it.",
].join("\n");

export function apply(ctx, config = {}) {
  const text = typeof config.text === "string" ? config.text : DEFAULT_RULES;
  if (!text.trim()) return;
  ctx.effect(() => ctx.systemPrompt.section({ name: "steak:rules", order: Number.isFinite(config.order) ? config.order : 9000, text }), "steak-rules.section()");
}
