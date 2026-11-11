/**
 * Owned paths for DeepSeek Harness: file edits are refused outside the paths this task owns.
 *
 * config.paths is a list of absolute paths (files or directories). Empty or missing means the plugin does nothing.
 * Only the file-editing tools are gated; reads and shell commands are left to the harness permission preset.
 * Symlinks are resolved through the nearest existing ancestor, so a link cannot point an edit out of the owned set.
 */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export const name = "steak-owned-paths";
export const inject = ["tools"];

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "str_replace_editor"]);
const PATCH_TARGET = /^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/gm;

/** Resolve symlinks of the nearest existing ancestor, keeping the not-yet-existing tail. */
export function realPath(path) {
  let current = resolve(path);
  const tail = [];
  for (let hops = 0; hops < 64; hops++) {
    try {
      const real = realpathSync(current);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      // A dangling symlink still resolves: follow its target even when the target does not exist yet.
      let link;
      try {
        link = lstatSync(current).isSymbolicLink() ? readlinkSync(current) : undefined;
      } catch { link = undefined; }
      if (link !== undefined) {
        current = resolve(dirname(current), link);
        continue;
      }
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(basename(current));
      current = parent;
    }
  }
  return resolve(path); // symlink loop: nothing can be written through it anyway
}

/**
 * Pure decision: true when `target` (absolute, or relative to `cwd`) lands outside every owned path.
 * An empty owned list allows everything; an unusable target is outside (nothing can be verified).
 */
export function outside(target, cwd, ownedPaths) {
  if (!Array.isArray(ownedPaths) || ownedPaths.length === 0) return false;
  if (typeof target !== "string" || !target.trim()) return true;
  const real = realPath(isAbsolute(target) ? target : resolve(cwd ?? process.cwd(), target));
  return !ownedPaths.some((owned) => {
    if (typeof owned !== "string" || !owned.trim()) return false;
    const boundary = realPath(resolve(cwd ?? process.cwd(), owned));
    // The filesystem root already ends with the separator; boundary + sep would become "//" and match nothing.
    const prefix = boundary.endsWith(sep) ? boundary : boundary + sep;
    return real === boundary || real.startsWith(prefix);
  });
}

/** The file paths one edit call would touch. */
export function targetsOf(toolName, args) {
  const input = args && typeof args === "object" ? args : {};
  if (toolName === "apply_patch") {
    const text = typeof input.input === "string" ? input.input : typeof input.patch === "string" ? input.patch : "";
    return [...text.matchAll(PATCH_TARGET)].map((match) => match[1].trim());
  }
  const path = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : undefined;
  return path === undefined ? [] : [path];
}

export function apply(ctx, config = {}) {
  const paths = Array.isArray(config.paths) ? config.paths.filter((p) => typeof p === "string" && p.trim()) : [];
  if (paths.length === 0) return;
  const list = paths.join(", ");
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (!EDIT_TOOLS.has(exec.name)) return next();
    let cwd = process.cwd();
    try {
      const dir = ctx.get?.("workingDirectory")?.get(exec.agent?.session);
      if (typeof dir === "string" && isAbsolute(dir)) cwd = dir;
    } catch { /* fall through to the launch directory */ }
    const targets = targetsOf(exec.name, exec.arguments);
    if (targets.length === 0) {
      return { kind: "deny", reason: `steak-dsh: ${exec.name} call names no file path, so it cannot be checked against this task's owned paths (${list})` };
    }
    for (const target of targets) {
      if (outside(target, cwd, paths)) {
        return { kind: "deny", reason: `steak-dsh: ${target} is outside this task's owned paths (${list})` };
      }
    }
    return next();
  });
}
