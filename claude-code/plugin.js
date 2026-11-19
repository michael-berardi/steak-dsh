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

export const name = "steak-claude-code";
export const inject = ["llm"];

const harness = await loadHarness();

export function apply(ctx, config = {}) {
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : undefined;
  const command = typeof config.command === "string" && config.command ? config.command : undefined;
  // Operator config for the silence limits becomes the same environment names the route reads, unless already set there.
  const limits = {};
  if (Number.isFinite(config.idleLimitMs) && config.idleLimitMs > 0) limits.STEAK_DSH_CLAUDE_CODE_IDLE_LIMIT_MS = String(Math.round(config.idleLimitMs));
  if (Number.isFinite(config.firstByteLimitMs) && config.firstByteLimitMs > 0) limits.STEAK_DSH_CLAUDE_CODE_FIRST_BYTE_LIMIT_MS = String(Math.round(config.firstByteLimitMs));
  if (Number.isInteger(config.maxRecoveries) && config.maxRecoveries >= 0 && config.maxRecoveries <= 10) limits.STEAK_DSH_CLAUDE_CODE_MAX_RECOVERIES = String(config.maxRecoveries);
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
