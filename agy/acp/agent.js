/**
 * The minimal agent the ACP server runs. Its workspace has exactly one custom agent with an empty `tools` list and
 * all default components excluded, so agy has no native file/shell tools; only the host's loopback MCP tools remain.
 * The directory lives under DSH's own private home and is deleted with the session. Nothing here reads an agy
 * credential, an agy home, or a token file: agy's own cached sign-in is used unchanged.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const AGENT_NAME = "steak-dsh-bridge";

const AGENT_MD = `---
name: ${AGENT_NAME}
description: "Steak DSH ACP bridge: no native tools; work only through the host's MCP tools"
tools: []
excludeDefaultComponents: true
mainAgent: true
subagent: false
commandExecutionPolicy: off
---
You are the answering model inside a Steak DSH session. The harness owns the conversation, the tools, their approvals and their owned paths. Use only the tools exposed by the steak-dsh-tools MCP server, passing each tool's documented arguments unchanged. Do not use any native file, shell, browser or subagent capability; none is available to you. If a task cannot be done with the exposed tools, say so instead of attempting it another way.
`;

/** A private workspace holding the minimal agent and the ACP log, removed when the session closes. */
export function createBridgeAgent(env = process.env) {
  const home = String(env.DSH_HOME ?? "").trim() || join(homedir(), ".dsh");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(home, "steak-dsh-acp-"));
  chmodSync(dir, 0o700);
  const agentDir = join(dir, ".agents", "agents", AGENT_NAME);
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(agentDir, "agent.md"), AGENT_MD, { mode: 0o600 });
  const logFile = join(dir, `acp-${randomBytes(4).toString("hex")}.log`);
  return {
    dir,
    agentName: AGENT_NAME,
    logFile,
    dispose() { rmSync(dir, { recursive: true, force: true }); },
  };
}
