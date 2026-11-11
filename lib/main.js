/** Command dispatch, install, doctor, help. */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseOptions, requireKeyEnv } from "./args.js";
import { chatCommand } from "./chat.js";
import { resolveDsh, versionOf, warnIfOutOfRange } from "./dsh.js";
import { UsageError } from "./errors.js";
import { runCommand } from "./run.js";
import { satisfies } from "./semver.js";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const HELP = `steak-dsh ${pkg.version} — DeepSeek Harness with the Steak DSH bundle, nothing to set up.

usage:
  steak-dsh run [options] <task... | ->   one headless task, then exit
  steak-dsh chat [options]                line-based terminal chat (/exit, /new, Ctrl-C cancels a turn)
  steak-dsh install [--profile <name>]    add this bundle to a dsh profile (default: headless)
  steak-dsh doctor                        check dsh, the bundle and the plugins
  steak-dsh --version | --help

run/chat options:
  --model <provider>/<model-id>           model for this run (the id may contain slashes)
  --base-url <url>                        declare a gateway route named <provider> (needs --model, --api, --key-env)
  --api <name>                            openai-completions | openai-responses | anthropic-messages
  --key-env <ENV_NAME>                    name of the env var holding the key (never the key itself)
  --context-window <n>                    context window for the declared model
  --effort <level>                        reasoning effort for this run
  --compat <json object>                  route compatibility switches, e.g. '{"supportsDeveloperRole":false}'
  --permission <preset>                   read-only | workspace-write (default) | danger-full-access
  --add-dir <abs path>                    extra writable root, repeatable
  --owned-path <abs path>                 refuse file edits outside these paths, repeatable
  --no-shell                              disable the shell tools (bash, pwsh, jobs)
  --session-id <id>                       continue a session
  --json                                  dsh NDJSON events on stdout, unchanged (run only)
  --patch <file>                          extra overlay, repeatable, applied last
  --stock                                 skip the Steak DSH bundle (A/B comparisons)
  --verify <command>                      verify-after-edit command for this run

dsh is found via STEAK_DSH_DSH_BIN, else on PATH. User dsh profiles are never modified by run/chat.`;

function dshHome(env = process.env) {
  const configured = (env.DSH_HOME ?? "").trim();
  return configured || join(homedir(), ".dsh");
}

function profileManifest(name, env = process.env) {
  try {
    return JSON.parse(readFileSync(join(dshHome(env), "profiles", name, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function spawnInherit(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: "inherit", env: { ...process.env } });
    child.on("error", (error) => reject(new Error(`could not start dsh (${bin}): ${error.message}`)));
    child.on("close", (code, signal) => resolve(signal ? 128 + 15 : (code ?? 1)));
  });
}

async function installCommand(argv) {
  let profile = "headless";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile") {
      profile = argv[++i];
      if (!profile) throw new UsageError("--profile needs a name");
    } else {
      throw new UsageError(`unknown install option ${argv[i]}`);
    }
  }
  const bin = resolveDsh();
  warnIfOutOfRange(bin, pkg.engines.dsh);
  const before = profileManifest(profile)?.dsh?.profile?.bundles ?? [];
  const code = await spawnInherit(bin, ["plugin", "--profile", profile, "add", root]);
  if (code === 0) {
    const after = profileManifest(profile)?.dsh?.profile?.bundles ?? [];
    const added = after.filter((bundle) => !before.includes(bundle));
    process.stdout.write(added.length > 0
      ? `steak-dsh: profile "${profile}" now enables: ${added.join(", ")}\n`
      : `steak-dsh: profile "${profile}" bundles unchanged (${after.join(", ") || "none listed"})\n`);
  }
  return code;
}

async function doctorCommand() {
  const bin = resolveDsh();
  const version = versionOf(bin);
  process.stdout.write(`dsh: ${bin} (${version ?? "version unknown"})\n`);
  if (version === undefined) process.stderr.write("steak-dsh: warning: could not read the dsh version; continuing\n");
  else if (!satisfies(version, pkg.engines.dsh)) {
    process.stderr.write(`steak-dsh: warning: dsh ${version} is outside the supported range "${pkg.engines.dsh}"; continuing\n`);
  }
  const bundle = join(root, "cordis.patch.yml");
  const bundleOk = existsSync(bundle);
  process.stdout.write(`bundle: ${bundle} (${bundleOk ? "present" : "MISSING"})\n`);
  let ok = bundleOk;
  const dir = join(root, "plugins");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".js")).sort()) {
    try {
      const mod = await import(pathToFileURL(join(dir, file)).href);
      if (typeof mod.name !== "string" || !Array.isArray(mod.inject) || typeof mod.apply !== "function") {
        throw new Error("missing named exports name/inject/apply");
      }
      process.stdout.write(`plugin ${file}: ok (${mod.name})\n`);
    } catch (error) {
      ok = false;
      process.stdout.write(`plugin ${file}: FAILED — ${error.message}\n`);
    }
  }
  return ok ? 0 : 1;
}

export async function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case "run": {
      const { options, task } = parseOptions(rest);
      const bin = resolveDsh();
      warnIfOutOfRange(bin, pkg.engines.dsh);
      requireKeyEnv(options);
      return runCommand(options, task, { root, bin });
    }
    case "chat": {
      const { options } = parseOptions(rest, { allowTask: false });
      const bin = resolveDsh();
      warnIfOutOfRange(bin, pkg.engines.dsh);
      requireKeyEnv(options);
      return chatCommand(options, { root, bin });
    }
    case "install":
      return installCommand(rest);
    case "doctor":
      if (rest.length > 0) throw new UsageError(`doctor takes no options, got ${rest.join(" ")}`);
      return doctorCommand();
    case "--version":
    case "-v":
      process.stdout.write(pkg.version + "\n");
      return 0;
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(HELP + "\n");
      return command === undefined ? 2 : 0;
    default:
      throw new UsageError(`unknown command "${command}" (try --help)`);
  }
}
