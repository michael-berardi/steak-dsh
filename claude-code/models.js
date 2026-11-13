/**
 * Model rows from Claude Code's own catalog. Nothing here names a model: ids, names, context size and effort
 * levels all come from what the installed CLI reports for the logged-in account.
 */

const DEFAULT_CONTEXT = 200_000;
const LARGE_CONTEXT = 1_000_000;

/**
 * The id a row is offered under: the full model id the CLI says the row resolves to (without the context suffix),
 * so the same model has the same id wherever it is listed. The CLI's default row keeps its own name, and a row
 * the CLI does not resolve keeps the value the CLI gave it.
 */
export function offeredId(row) {
  if (row.value === "default" || typeof row.resolvedModel !== "string" || !row.resolvedModel) return row.value;
  return row.resolvedModel.replace(/\[1m\]$/u, "");
}

/** The CLI's catalog row, reduced to what the route uses. `native` is what the CLI itself calls the row. */
export function normalizeRow(row) {
  return {
    id: offeredId(row),
    native: row.value,
    name: row.displayName,
    description: row.description,
    contextWindow: Number.isInteger(row.contextWindow) && row.contextWindow > 0
      ? row.contextWindow
      : (/\b1M context\b/iu.test(row.description ?? "") || /\[1m\]$/u.test(row.value) ? LARGE_CONTEXT : DEFAULT_CONTEXT),
    maxTokens: Number.isInteger(row.maxTokens) && row.maxTokens > 0 ? row.maxTokens : undefined,
    efforts: Array.isArray(row.supportedEffortLevels) ? row.supportedEffortLevels.filter((level) => typeof level === "string" && level) : [],
    adaptive: row.supportsAdaptiveThinking === true,
  };
}

/** Listing entry (LlmModelInfo) for one catalog row. */
export function listedModel(provider, row) {
  return {
    provider,
    id: row.id,
    name: `${row.name} (Claude Code)`,
    ...(row.description ? { description: row.description } : {}),
    inputModalities: ["text"],
  };
}

/** Exact-route metadata (LlmResolvedModelInfo) for one catalog row. */
export function resolvedModel(provider, row, ReasoningEffortId = (id) => id) {
  return {
    ...listedModel(provider, row),
    context: { contextWindow: row.contextWindow },
    ...(row.efforts.length
      ? { reasoning: { efforts: row.efforts.map((level) => ({ id: ReasoningEffortId(level), name: level })) } }
      : {}),
  };
}

/** Metadata for a model id the catalog does not list: routing accepts it and the CLI decides. */
export function plainModel(provider, id) {
  return { provider, id, name: id, inputModalities: ["text"] };
}

/** Catalog rows to normalized rows, dropping anything without an id and repeats. */
export function rowsFromDiscovery(discovered) {
  const seen = new Set();
  const rows = [];
  for (const raw of discovered) {
    const row = normalizeRow(raw);
    if (!row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  return rows;
}
