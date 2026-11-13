/**
 * `steak-dsh models`: every model the bundle's two login-backed routes offer right now, one `provider/model-id`
 * per line. Read-only: it asks each route's own source (the installed CLI, the backend) and prints what it says.
 * Nothing is listed in the bundle, so an empty answer means the source offered nothing, and the reason is named.
 */
import { discoverClaudeModels, getClaudeStatus } from "../claude-code/claude-cli.js";
import { PROVIDER_ID as CLI_PROVIDER } from "../claude-code/adapter.js";
import { rowsFromDiscovery } from "../claude-code/models.js";
import { PROVIDER_ID as LOGIN_PROVIDER } from "../codex/adapter.js";
import { codexAccess } from "../codex/auth.js";
import { clientVersion, fetchCodexModels } from "../codex/models.js";
import { UsageError } from "./errors.js";

/** One source per route: resolves to model ids, or rejects with an error whose message names the cause. */
export function defaultSources(env = process.env) {
  return {
    [CLI_PROVIDER]: async () => {
      const status = await getClaudeStatus(env, undefined);
      if (!status.available || !status.loggedIn) {
        throw Object.assign(new Error(status.detail ?? "the CLI is not installed or not logged in"), { code: "CLAUDE_CODE_NOT_READY" });
      }
      return rowsFromDiscovery(await discoverClaudeModels(env, undefined)).map((row) => row.id);
    },
    [LOGIN_PROVIDER]: async () => {
      const rows = await fetchCodexModels({ access: await codexAccess({ env }), version: clientVersion(env) });
      return rows.map((row) => row.id);
    },
  };
}

/**
 * @param {string[]} argv `--json` and/or `--provider <name>` (repeatable)
 * @param {{sources?: Record<string, () => Promise<string[]>>, out?: (text: string) => void, err?: (text: string) => void}} [io]
 * @returns {Promise<number>} 0 when every asked route answered, 1 when one did not (its reason is on stderr)
 */
export async function modelsCommand(argv, { sources = defaultSources(), out = (text) => process.stdout.write(text), err = (text) => process.stderr.write(text) } = {}) {
  let json = false;
  const wanted = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") json = true;
    else if (argv[i] === "--provider") {
      const value = argv[++i];
      if (!value) throw new UsageError("--provider needs a name");
      if (!(value in sources)) throw new UsageError(`--provider must be one of ${Object.keys(sources).join(", ")}, got "${value}"`);
      wanted.push(value);
    } else throw new UsageError(`unknown models option ${argv[i]}`);
  }
  const providers = wanted.length ? [...new Set(wanted)] : Object.keys(sources);
  const answers = await Promise.all(providers.map(async (provider) => {
    try {
      return { provider, ids: [...new Set(await sources[provider]())].sort() };
    } catch (error) {
      return { provider, ids: [], error: { code: typeof error?.code === "string" && error.code ? error.code : "FAILED", message: String(error?.message ?? error) } };
    }
  }));
  const models = answers.flatMap((answer) => answer.ids.map((id) => `${answer.provider}/${id}`));
  if (json) {
    const routes = Object.fromEntries(answers.map((answer) => [answer.provider, answer.error ? { models: 0, error: answer.error } : { models: answer.ids.length }]));
    out(`${JSON.stringify({ models, routes }, null, 2)}\n`);
  } else {
    for (const model of models) out(`${model}\n`);
  }
  for (const answer of answers) {
    if (answer.error) err(`steak-dsh: ${answer.provider}: no models: ${answer.error.code}: ${answer.error.message}\n`);
  }
  return answers.some((answer) => answer.error) ? 1 : 0;
}
