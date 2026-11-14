/**
 * A sandbox escalation in a session that never asks: refuse it up front and say what would allow it.
 *
 * With approval policy `never` the harness rejects a call that asks for a wider sandbox (`sandbox_permissions`), but
 * its error reads as if a person had said no ("the user rejected escalating ..."). Nobody was asked. This plugin
 * refuses the same call before it runs, with a reason that names the policy, the current preset and the preset that
 * would allow the call, so the model can tell the user instead of retrying another way.
 *
 * It acts only when the session's effective approval policy is `never` and the requested mode is wider than the
 * session's sandbox mode; every other call passes through untouched.
 */
export const name = "steak-approval-never";
export const inject = ["tools"];

/** Modes a call may escalate to from each mode (the harness's own order). */
const WIDER = { "read-only": ["workspace-write", "danger-full-access"], "workspace-write": ["danger-full-access"] };

export function refusalText(requested, mode) {
  return `steak-dsh: refused without asking anyone: this call asks for the "${requested}" sandbox, and this session ` +
    `runs the "${mode}" preset with approval policy "never", so no approval prompt is shown and no escalation is ` +
    `granted. Do not retry it another way. Tell the user the command needs the ${requested} preset: start ` +
    `steak-dsh with --permission ${requested} (or with --approval-policy ask to be asked each time), or type ` +
    `/permission ${requested} in the terminal UI.`;
}

/** The refusal for one call, or undefined when the call may go on. Exported for tests. */
export function escalationRefusal(args, policy, mode) {
  const requested = args && typeof args === "object" ? args.sandbox_permissions : undefined;
  if (typeof requested !== "string" || policy !== "never") return undefined;
  if (!(WIDER[mode] ?? []).includes(requested)) return undefined;
  return refusalText(requested, mode);
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  ctx.on("tools/pre-execute", async (exec, next) => {
    const args = exec.arguments;
    if (!args || typeof args !== "object" || typeof args.sandbox_permissions !== "string") return next();
    const session = exec.agent?.session;
    if (session === undefined) return next();
    let policy;
    let mode;
    try { policy = ctx.get?.("approval")?.effectivePolicy?.(session); } catch { /* no approval service: pass through */ }
    try { mode = ctx.get?.("sandboxPolicy")?.resolve?.({ session })?.mode; } catch { /* no sandbox policy: pass through */ }
    const reason = escalationRefusal(args, policy, mode);
    return reason === undefined ? next() : { kind: "deny", reason };
  });
}
