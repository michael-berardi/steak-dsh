/**
 * Steak DSH agy route: registers the `agy` model provider. Requests run through Google's official Antigravity CLI
 * (`agy`) in headless mode on the operator's own agy sign-in; agy runs its own tools under its own permission rules.
 * Nothing is started until a model is listed or a request is made.
 */
import { createAgyAdapter, PROVIDER_ID } from "./adapter.js";
import { loadHarness } from "../claude-code/harness.js";

export const name = "steak-agy";
export const inject = ["llm"];

const harness = await loadHarness();

export function apply(ctx, config = {}) {
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : undefined;
  const command = typeof config.command === "string" && config.command ? config.command : undefined;
  const env = () => ({ ...process.env, ...(command && !process.env.STEAK_DSH_AGY_BIN ? { STEAK_DSH_AGY_BIN: command } : {}) });
  const envTimeout = Number(process.env.STEAK_DSH_AGY_TIMEOUT_MS);
  const note = (message) => process.stderr.write(`${message}\n`);
  const adapter = createAgyAdapter(harness, { env, timeoutMs: Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : timeoutMs, report: note });
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER_ID], adapter), "steak-agy.registerAdapter()");
}
