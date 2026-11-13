/**
 * Steak DSH Codex route: registers the `openai-codex` model provider.
 *
 * Requests go to the Codex Responses endpoint on the user's own ChatGPT login, the one the official Codex CLI
 * keeps. The harness keeps the conversation, the tools and the approvals. Nothing is read or fetched until a model
 * is listed or a request is made, so a machine without a Codex login pays nothing.
 */
import { createCodexAdapter, PROVIDER_ID } from "./adapter.js";
import { loadCodexHarness } from "./harness.js";

export const name = "steak-codex";
export const inject = ["llm"];

const harness = await loadCodexHarness();

export function apply(ctx, config = {}) {
  const text = (value) => (typeof value === "string" && value ? value : undefined);
  const home = text(config.home);
  const version = text(config.clientVersion);
  const env = () => ({
    ...process.env,
    ...(home ? { STEAK_DSH_CODEX_HOME: home } : {}),
    ...(version ? { STEAK_DSH_CODEX_CLIENT_VERSION: version } : {}),
  });
  const note = (message) => process.stderr.write(`${message}\n`);
  const adapter = createCodexAdapter(harness, { env, report: note, baseUrl: text(config.baseUrl), tokenUrl: text(config.tokenUrl) });
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER_ID], adapter), "steak-codex.registerAdapter()");
}
