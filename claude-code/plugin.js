/**
 * Steak DSH Claude Code route: registers the `claude-code` model provider.
 *
 * Requests run through the official Claude Code CLI on the user's own subscription login. The harness keeps the
 * conversation, the tools and the approvals; Claude Code only generates. Nothing is started until a model is
 * listed or a request is made, so a machine without Claude Code pays nothing.
 */
import { createClaudeCodeAdapter, PROVIDER_ID } from "./adapter.js";
import { setClaudeCodeDiagnosticReporter } from "./claude-cli.js";
import { loadHarness } from "./harness.js";
import { checkedCount, checkedMs } from "./idle-policy.js";

export const name = "steak-claude-code";
export const inject = ["llm"];

const harness = await loadHarness();

export function apply(ctx, config = {}) {
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : undefined;
  const command = typeof config.command === "string" && config.command ? config.command : undefined;
  // Operator config for the silence limits becomes the same environment names the route reads, unless already set there.
  // A bad value is a named error here, when the plugin is applied, not a silent default or a failure on the first request.
  const limits = {};
  if (config.idleLimitMs !== undefined) limits.STEAK_DSH_CLAUDE_CODE_IDLE_LIMIT_MS = String(checkedMs("claude-code plugin config idleLimitMs", config.idleLimitMs));
  if (config.firstByteLimitMs !== undefined) limits.STEAK_DSH_CLAUDE_CODE_FIRST_BYTE_LIMIT_MS = String(checkedMs("claude-code plugin config firstByteLimitMs", config.firstByteLimitMs));
  if (config.maxRecoveries !== undefined) limits.STEAK_DSH_CLAUDE_CODE_MAX_RECOVERIES = String(checkedCount("claude-code plugin config maxRecoveries", config.maxRecoveries));
  const env = () => ({ ...limits, ...process.env, ...(command ? { STEAK_DSH_CLAUDE_CODE_COMMAND: command } : {}) });
  const note = (message) => process.stderr.write(`${message}\n`);
  setClaudeCodeDiagnosticReporter(note);
  const adapter = createClaudeCodeAdapter(harness, { env, timeoutMs, report: note });
  ctx.effect(() => {
    const registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter);
    return () => {
      registration();
      setClaudeCodeDiagnosticReporter(undefined);
      void adapter.close();
    };
  }, "steak-claude-code.registerAdapter()");
}
