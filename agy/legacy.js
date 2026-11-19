/** The retired direct-OAuth route: its config file is detected only to tell the operator it is gone. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function legacyConfigPath(env = process.env) {
  const configured = (env.DSH_HOME ?? "").trim();
  return join(configured || join(homedir(), ".dsh"), "steak-dsh-antigravity.json");
}

export const REMOVED_LINE =
  "steak-dsh: the antigravity route was removed because Google's terms forbid third-party Antigravity OAuth; use --model agy/<id> (see README: Google Antigravity CLI)";

/** The one-line notice when the old config file exists, else undefined. */
export function legacyNotice(env = process.env) {
  return existsSync(legacyConfigPath(env)) ? REMOVED_LINE : undefined;
}
