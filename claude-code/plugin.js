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
  const env = () => (command ? { ...process.env, STEAK_DSH_CLAUDE_CODE_COMMAND: command } : process.env);
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
