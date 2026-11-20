/**
 * Steak DSH agy route: registers the `agy` model provider. Google's official Antigravity CLI runs either as a
 * long-lived ACP session (its tools replaced by Steak DSH's own through a loopback MCP bridge) or, as the fallback,
 * in headless mode. STEAK_DSH_AGY_TRANSPORT=acp|headless|auto selects it on first use; no process starts at load.
 */
import { PROVIDER_ID } from "./adapter.js";
import { createAgyTransportAdapter as createTransport } from "./acp/adapter.js";
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
  const adapter = createTransport(harness, { env, timeoutMs: Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : timeoutMs, report: note });
  ctx.effect(() => {
    const unregister = ctx.llm.registerAdapter([PROVIDER_ID], adapter);
    return () => { unregister?.(); void adapter.close(); };
  }, "steak-agy.registerAdapter()");
}
