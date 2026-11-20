/**
 * Mode selection. `auto` uses ACP only when the installed agy answers `agy acp --help`, exactly as Google documents
 * for checking ACP support; the reason for every fallback is returned so the route can log it. An explicit `acp`
 * never silently falls back.
 */
import { spawnSync } from "node:child_process";
import { AgyError, CODES } from "../errors.js";

export const MODES = ["acp", "headless", "auto"];

/** Google: "Run agy acp --help in a terminal to confirm that your installed version includes ACP." */
export function probeAcp(env = process.env, timeoutMs = 5_000) {
  const command = String(env.STEAK_DSH_AGY_BIN ?? "").trim() || "agy";
  try {
    const run = spawnSync(command, ["acp", "--help"], { env, encoding: "utf8", maxBuffer: 1_048_576, timeout: timeoutMs, windowsHide: true });
    if (run.error) return { available: false, reason: `agy acp --help could not be run: ${run.error.message}` };
    if (run.status !== 0) return { available: false, reason: `agy acp --help exited ${run.status ?? "no status"}` };
    // Exit zero alone is not proof: a headless-mode fake can do that too. A real ACP binary prints its flags.
    const help = String(run.stdout ?? "");
    if (!/--(?:agent|process-per-session|disable-telemetry)/.test(help)) {
      return { available: false, reason: "agy acp --help printed no ACP flags" };
    }
    return { available: true, reason: "agy acp --help succeeded" };
  } catch (error) {
    return { available: false, reason: `agy acp --help failed: ${error.message}` };
  }
}

/** @returns {{transport: "acp"|"headless", reason: string}} */
export function selectTransport(env = process.env) {
  // The PI sibling uses the same flag; honour either name so one operator setting covers both bundles.
  const raw = env.STEAK_DSH_AGY_TRANSPORT ?? env.STEAK_PI_AGY_TRANSPORT ?? "";
  const requested = String(raw).trim().toLowerCase() || "auto";
  if (!MODES.includes(requested)) {
    throw new AgyError(`STEAK_DSH_AGY_TRANSPORT must be acp, headless or auto, got "${requested}"`, CODES.BAD_REQUEST);
  }
  if (requested === "headless") return { transport: "headless", reason: "STEAK_DSH_AGY_TRANSPORT=headless" };
  const probe = probeAcp(env);
  if (probe.available) return { transport: "acp", reason: probe.reason };
  if (requested === "acp") {
    throw new AgyError(`STEAK_DSH_AGY_TRANSPORT=acp but ${probe.reason}`, CODES.ACP_UNSUPPORTED ?? "AGY_ACP_UNSUPPORTED");
  }
  return { transport: "headless", reason: `${probe.reason}; using the headless agy route` };
}
