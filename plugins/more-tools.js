/**
 * Adaptive tools for DeepSeek Harness: the heavier tools arrive when the work needs them.
 *
 * The bundle ships the subagent, follow-up and working-directory tools switched off, because their schemas cost
 * tokens on every request. This plugin registers one tiny tool, `more_tools`. When the model calls it, the loader
 * rows named in `rows` are switched on, and the tools they register are part of the next request.
 * Nothing is added to the conversation until then. No imports from the harness.
 */
export const name = "steak-more-tools";
export const inject = ["tools", "loader"];

export const TOOL_NAME = "more_tools";
export const DEFAULT_ROWS = [
  "tool-subagent",
  "tool-subagent-control",
  "tool-working-directory",
  // Long work returns big tool results more often: keep more of them inline, as the long-work profile does.
  { id: "spill-policy", config: { maxInlineTokens: 12500 } },
];
const DESCRIPTION = "Add the subagent and working-directory tools for long or delegating work. Available from your next step.";

/** A row is an id, or { id, config }: the config is merged into the row's own config when the row is switched on. */
const rowId = (row) => (typeof row === "string" ? row : row.id);

/** Switch the named rows on. Returns the ids now enabled, the ids that were already on, and the ids it could not find. */
export async function enableRows(loader, rows) {
  const enabled = [];
  const already = [];
  const missing = [];
  for (const row of rows) {
    const id = rowId(row);
    const entry = [...loader.entries()].find((candidate) => candidate.options.id === id);
    if (!entry) {
      missing.push(id);
      continue;
    }
    const extra = typeof row === "object" ? row.config : undefined;
    const isOff = entry.options.disabled === true;
    const changesConfig = extra !== undefined && Object.entries(extra).some(([key, value]) => entry.options.config?.[key] !== value);
    if (!isOff && !changesConfig) {
      already.push(id);
      continue;
    }
    const options = { ...entry.options, disabled: false };
    if (extra !== undefined) options.config = { ...entry.options.config, ...extra };
    await entry.parent.tree.update(id, options);
    enabled.push(id);
  }
  return { enabled, already, missing };
}

export function apply(ctx, config = {}) {
  const rows = Array.isArray(config.rows) ? config.rows.filter((row) => typeof row === "string" || typeof row?.id === "string") : DEFAULT_ROWS;
  if (!rows.length) return;
  ctx.tools.register({
    name: TOOL_NAME,
    description: typeof config.description === "string" ? config.description : DESCRIPTION,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: { schema: { type: "object", additionalProperties: false, properties: { message: { type: "string" } }, required: ["message"] }, render: (_args, value) => [{ type: "text", text: value.message }] },
    async execute(_args, exec) {
      if (exec.agent !== undefined && exec.agent.isSubagent === true) throw new Error("more_tools is for the main session");
      const result = await enableRows(ctx.loader, rows);
      await ctx.loader.await?.();
      const have = [...result.enabled, ...result.already];
      return { message: have.length ? `Available now: ${have.filter((id) => id !== "spill-policy").join(", ")}.` : "Nothing to add: those tools are not part of this install." };
    },
  });
}
