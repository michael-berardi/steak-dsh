import { createHash } from "node:crypto";
import { ClaudeCodeError, CODES } from "./errors.js";

export const TOOL_PREFIX = "mcp__dsh__";

/**
 * The API caps tool names at 64 characters and TOOL_PREFIX takes 10, so a harness tool name can use 50.
 * Longer or non-ASCII names get a stable alias: a readable head plus the first 8 hex digits of the full
 * name's SHA-256. Short ASCII names are sent unchanged.
 */
export const MAX_CLAUDE_TOOL_NAME = 50;
const CLAUDE_TOOL_NAME = /^[A-Za-z0-9_-]{1,50}$/u;

export function claudeToolName(name) {
  if (CLAUDE_TOOL_NAME.test(name)) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  const head = name.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, MAX_CLAUDE_TOOL_NAME - hash.length - 1) || "tool";
  return `${head}_${hash}`;
}

/**
 * The harness tool name for a tool_use the model emitted. `toolNames` maps wire (alias) name to harness name.
 * Models sometimes drop the MCP prefix and call a tool by its bare name; that is the same call when the bare
 * name is one of the current tools. Any other name is not the harness's.
 */
export function harnessToolName(emitted, toolNames) {
  const wire = emitted.startsWith(TOOL_PREFIX) ? emitted.slice(TOOL_PREFIX.length) : emitted;
  const name = toolNames.get(wire);
  if (name === undefined) {
    throw new ClaudeCodeError(
      emitted.startsWith(TOOL_PREFIX) ? `Claude Code returned unavailable tool ${wire}` : `Claude Code returned unexpected tool ${emitted}`,
      CODES.UNKNOWN_TOOL,
    );
  }
  return name;
}
