/** `steak-dsh antigravity login | status | logout`. Loaded only when that command is run. */
import { createInterface } from "node:readline";
import { access, login, readCredential, removeCredential } from "./auth.js";
import { configPath, credentialPath, loadConfig } from "./config.js";
import { AntigravityError, CODES } from "./errors.js";

function requireConfig(env, version) {
  const config = loadConfig(env, version);
  if (!config) {
    throw new AntigravityError(`Antigravity is not turned on: create ${configPath(env)} with {"enabled": true, "clientId": "...", "clientSecret": "..."} (chmod 600) and run this again`, CODES.NOT_CONFIGURED);
  }
  return config;
}

/**
 * @param {string[]} argv `login`, `status` or `logout`
 * @param {{env?: object, version?: string, out?: (t: string) => void, err?: (t: string) => void, prompt?: (message: string, signal: AbortSignal) => Promise<string>}} [io]
 * @returns {Promise<number>} exit status
 */
export async function antigravityCommand(argv, { env = process.env, version, out = (t) => process.stdout.write(t), err = (t) => process.stderr.write(t), prompt } = {}) {
  const [sub, ...rest] = argv;
  if (rest.length) throw Object.assign(new Error(`antigravity ${sub} takes no arguments, got "${rest.join(" ")}"`), { exitCode: 2 });
  switch (sub) {
    case "login": {
      const config = requireConfig(env, version);
      const ask = prompt ?? ((message, signal) => new Promise((resolve, reject) => {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        const onAbort = () => { rl.close(); reject(new Error("prompt aborted")); };
        signal.addEventListener("abort", onAbort, { once: true });
        rl.question(`${message}\n> `, (answer) => { signal.removeEventListener("abort", onAbort); rl.close(); resolve(answer); });
      }));
      await login(config, { notify: (url, instructions) => out(`${instructions}\n\n${url}\n\n`), prompt: ask }, { env });
      out(`steak-dsh: signed in to Antigravity; the sign-in is saved in ${credentialPath(env)} (owner-only).\n`);
      return 0;
    }
    case "status": {
      const config = requireConfig(env, version);
      const credential = readCredential(env);
      const session = await access({ config, env });
      void session;
      out(`antigravity: signed in; project ${credential.projectId}; access token ${credential.expires > Date.now() ? "valid" : "renewed just now"}.\n`);
      return 0;
    }
    case "logout":
      removeCredential(env);
      out(`steak-dsh: removed ${credentialPath(env)} (the sign-in stays valid at Google until you revoke the app in your Google account).\n`);
      return 0;
    default:
      err("usage: steak-dsh antigravity login | status | logout\n");
      return 2;
  }
}
