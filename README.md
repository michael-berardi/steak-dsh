# Steak DSH

[![Release](https://img.shields.io/github/v/release/michael-berardi/steak-dsh)](https://github.com/michael-berardi/steak-dsh/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](#install)

A plugin bundle and launcher for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`), for coding tasks in the terminal. It adds model flags, checks after edits,
file-edit boundaries and a smaller default tool inventory. The launcher leaves your existing profiles alone.
Node 22+, no runtime npm dependencies, MIT licensed. By [Pareto Cybernetics](https://paretocybernetics.com).

By default, the agent runs commands with full access to your machine and never stops to ask, so long coding sessions can finish while you are away.
Use `--permission workspace-write` or `--permission read-only` to request a sandbox.
Owned paths restrict file tools, not shell commands; add `--no-shell` when that boundary matters.

## Install

macOS and Linux:

```sh
curl -fsSL https://github.com/michael-berardi/steak-dsh/releases/latest/download/install.sh | sh
```

Windows (PowerShell 5.1 or 7):

```powershell
irm https://github.com/michael-berardi/steak-dsh/releases/latest/download/install.ps1 | iex
```

The installer checks release SHA-256 checksums. It uses an existing Node 22+ and dsh,
or installs private copies; it also attempts to add the bundle to the `headless`
profile. If that profile step fails, the launcher still works.
The supported dsh range is `>=0.2.2-rc.1 <0.3.0`.

Files live under `~/.steak-dsh`, commands under `~/.local/bin`. On Windows both live
under `%LOCALAPPDATA%\steak-dsh`. No sudo is needed. Follow the printed PATH instruction
if necessary, then use a model already configured in dsh:

```sh
steak-dsh doctor
steak-dsh run --permission workspace-write --verify "npm test" "fix the failing parser test"
```

Run the installer again to update. Overrides: `STEAK_DSH_HOME`, `STEAK_DSH_BIN_DIR`,
`STEAK_DSH_VERSION`, `STEAK_DSH_DSH_VERSION`, `STEAK_DSH_RELEASE_BASE`.
To remove it, delete the install directory and its command shims, then run
`dsh plugin --profile headless remove steak-dsh` if you added the profile bundle.

Already have Node and a supported dsh? Install only the launcher:

```sh
npm i -g github:michael-berardi/steak-dsh#v0.17.0
```

Or add only the plugin to a profile:

```sh
dsh plugin --profile headless add github:michael-berardi/steak-dsh#v0.17.0
```

### From source

With Node 22+ and a supported dsh installed:

```sh
git clone https://github.com/michael-berardi/steak-dsh.git
npm install -g ./steak-dsh
```

## Use

```sh
steak-dsh run --model deepseek-official/deepseek-flash "add a --json flag"
steak-dsh chat --model deepseek-official/deepseek-flash
steak-dsh tui --model deepseek-official/deepseek-flash --permission workspace-write --approval-policy ask
steak-dsh run --json --owned-path "$PWD/src" --no-shell "rename the parser helper"
steak-dsh --help
```

`run` emits text or, with `--json`, dsh NDJSON. Pass `--idle-timeout <sec>` (or set
`STEAK_DSH_IDLE_TIMEOUT_SEC`) with `run --json` to abort stalled streams (paused while a
`tool_call` awaits its `tool_result`), reap the child process group cleanly, emit a final
`stalled-stream` NDJSON/stderr cause, and exit `124`. `chat` is line-based; `tui` is
full-screen and requires `--model`. Both `chat` and `tui` support `/model <provider>/<model-id>`
to switch models in place while keeping the same session id. Only the TUI can answer approval
prompts; `run` and `chat` refuse requests needing approval even with `--approval-policy ask`.
`--add-dir` does not work over the TUI's SDK connection.

For a gateway, pass `--model provider/model`, `--base-url`, `--api` and `--key-env`.
The API is `openai-completions`, `openai-responses` or `anthropic-messages`.
`--key-env` takes an environment variable name, never the key itself.
`--effort` controls reasoning; `--stock` omits the bundle for comparisons.

Two optional login-backed routes are included (a third, `agy`, is described below):

- `claude-code/<model>` uses the installed Claude Code CLI and its login. Authenticate
  with `claude auth login`. API-key and alternative-billing environment settings are
  refused; usage credits require `STEAK_DSH_CLAUDE_CODE_ALLOW_USAGE_CREDITS=1`.
- `openai-codex/<model>` uses the Codex CLI's file login and dsh's Codex transport.
  Authenticate with `codex login`; keyring-only storage is not supported. Token renewal
  writes the refreshed login back to `auth.json`.

Both routes are text-only, need no gateway flags and cannot be used with `--stock`.
`steak-dsh models` lists their available models; `--json --provider openai-codex`
filters machine-readable output. A failed route reports an error and exit status 1.

### Google Antigravity CLI (`agy/<model-id>`)

`agy/<model-id>` runs Gemini models through Google's official Antigravity CLI (`agy`) in the headless mode Google
documents for scripting and CI (<https://antigravity.google/docs/cli/headless>). It needs your own `agy` and your own
sign-in; Steak DSH ships no model, no OAuth client and no credentials.

1. Install agy: `curl -fsSL https://antigravity.google/cli/install.sh | bash`
2. Sign in once by running `agy` interactively. Headless runs use that cached sign-in; they cannot sign in.
3. `steak-dsh models --provider agy` prints `agy/<id>` for what `agy models` lists. Your plan decides the list.
4. `steak-dsh run --model agy/<model-id> "your task"` (use an id that `steak-dsh models --provider agy` printed; `chat` and `tui` work the same).

**Two transports, selected by `STEAK_DSH_AGY_TRANSPORT=acp|headless|auto` (default `auto`).** `auto` uses ACP when
`agy acp --help` succeeds, and falls back to headless with a logged reason; `acp` fails with a named error instead of
falling back (`STEAK_PI_AGY_TRANSPORT` from the Steak Pi sibling is also honoured). Nothing is started until a model is listed or a request is made.

### ACP mode (default when available)

One long-lived `agy acp` session serves a whole DSH session: Google's documented ACP server
(<https://antigravity.google/docs/cli/acp/>), JSON-RPC over stdin/stdout. Steak DSH starts it with
`--agent steak-dsh-bridge --process-per-session --disable-telemetry --log-file <private path> --add-dir <cwd>`.
The minimal bridge agent has `tools: []` and `excludeDefaultComponents: true`, so agy has no native shell, file,
browser or subagent tools. `--process-per-session` is required by Google when the client configures an HTTP MCP
server. We do **not** pass `--dangerously-skip-permissions`; any permission request agy still makes is denied unless
the host supplies an approval decision. agy uses its own cached sign-in: no credential file or token is read, copied
or passed by this route.

**Tools run through DSH, never through the adapter.** A per-session loopback MCP server listens on 127.0.0.1 only, on
an OS-chosen port, with a random bearer token compared in constant time, and closes with the session. Its
`tools/list` is DSH's own tool declarations from the request. When agy calls `tools/call`, the adapter parks that HTTP
request (sending SSE/keep-alive whitespace while it waits), ends the current DSH model turn with a normal harness
tool-call block (`id`, `name`, `arguments`), and DSH validates, approves and executes the tool through its usual
permission and owned-path pipeline. On the next request the adapter matches the tool result back to the parked call,
answers MCP, and agy continues the *same* ACP prompt turn. Parallel calls are grouped into one harness turn; abort
answers parked calls with an error and cancels the ACP turn; a missing result is a named protocol error; resetting a
session closes its ACP child, listener and token. The context window comes from the server's `usage_update.size`, and
effort levels from its session options (Low/Medium/High/Extra/Max); cumulative input/cacheRead counts are scaled to
single-call occupancy so the harness does not compact early.

ACP failures are named, never silently swapped: `AGY_MISSING`, `AGY_NOT_SIGNED_IN` (ACP code `-32000`
"Authentication required"), `AGY_MODEL_UNAVAILABLE`, `AGY_ACP_PROTOCOL`, `AGY_ACP_BRIDGE`, `AGY_ACP_UNSUPPORTED`,
`AGY_TIMEOUT` and `AGY_CANCELLED`.

### Headless mode (fallback)

**Tool calls run inside agy, under agy's permission rules.** agy keeps its own agent loop, its own tools (shell, file
edits, MCP) and its own `settings.json` permission rules; the dsh harness does not run them. agy runs its own tools under
agy's permission rules, outside Steak DSH's approvals. Steak DSH never passes --dangerously-skip-permissions, so agy's
default permissions apply: per Google's docs, actions that need approval are not approved in headless mode (the run
continues without them); allow tools ahead of time with permissions.allow in ~/.gemini/antigravity-cli/settings.json
(<https://antigravity.google/docs/cli/permissions>). Any notice agy prints about this goes to stderr.
Both transports were tested only with fake ACP/headless agy fixtures and a signed-out agy, never a signed-in one.
Each agy tool step appears in the reply as a progress line such as `[agy tool: run_command echo hi]`, not as a
harness tool call, so the harness's own tools, `--permission` presets, `--owned-path` and verify-after-edit do not
govern what agy does. agy runs in the directory you launched from, with that directory added to its workspace.

How a run works: one `agy --input-format stream-json --output-format stream-json --model <id> --add-dir <cwd>` per turn, with the prompt sent on stdin as one stream-json user event (never on the command line)
(`--effort` when you pass `--effort`; `off` is sent as `low`, since agy has no off). The text agy streams is the reply;
token usage and the final status come from agy's `result` event. A later turn resumes agy's own conversation
(`--conversation <id>`) and sends only what you said since; without one, earlier turns are replayed as text, capped at 200 KB with the oldest turns dropped first (the prompt says so). When agy exits, its whole process group is killed so tools it started cannot outlive it. Text from agy that is shown (errors, notices) has URLs and control characters removed, so a sign-in link never appears. Abort sends SIGINT to agy's process group, then SIGTERM
after 3 s and SIGKILL after 2 s more. The route is text-only (an image is refused, named). Optional plugin config
(`steak-agy-route` row): `command` (the agy path; or set `STEAK_DSH_AGY_BIN`) and `timeoutMs` (or
`STEAK_DSH_AGY_TIMEOUT_MS`; default none, as in agy).

Named failures, no silent fallback: agy missing (`AGY_MISSING`, with the install command above); not signed in
(`AGY_NOT_SIGNED_IN`: agy's own words plus `run agy once to sign in`); the plan lacks the model
(`AGY_MODEL_UNAVAILABLE`); `AGY_TIMEOUT`; `AGY_CANCELLED` (agy status `CANCELED` or `INTERRUPTED`, or an abort);
`AGY_INVALID`; `AGY_FAILED` (any other `ERROR`, or agy exiting without a result). `steak-dsh doctor` reports whether
agy is installed and signed in.

**Removed: the direct Antigravity OAuth route** (`antigravity/<id>`, `steak-dsh antigravity login|status|logout`).
Google's terms say: "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with
Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or termination of your
Antigravity and/or Gemini CLI accounts." (<https://antigravity.google/terms>). If `$DSH_HOME/steak-dsh-antigravity.json`
still exists, `steak-dsh doctor` and `--model antigravity/...` print one line saying so; delete the file and the saved
`steak-dsh-antigravity-auth.json`, and use `--model agy/<id>`.

## Local models

`steak-dsh run|chat|tui --model local/<id>` runs on a local model added with Steak Pi's local manager (`steak-pi local add ...`). It needs that manager (`steak-pi` on PATH, or `STEAK_DSH_STEAK_PI`); without it, or to use any OpenAI-compatible server yourself, pass `--model <provider>/<id> --base-url ... --api ... --key-env ...`.

```
steak-dsh run --model local/my-model "your task"
```

The launcher runs `steak-pi local ensure <id>` first (it starts the server on demand and takes a lease), declares the returned endpoint as an `openai-completions` route named `local` with a placeholder key it sets itself (no key to export), and runs `steak-pi local release <id>` when the run ends, however it ends. The context window comes from the profile's `ctx` (`$PI_CODING_AGENT_DIR` or `~/.pi/agent`, `local/profiles/<id>.json`) unless `--context-window` is given. Holds and refusals pass through unchanged: the tool's message is printed and the launcher exits 2 without starting dsh. A model added with a LoRA adapter in `steak-pi local` works the same way. `--base-url`, `--api` and `--key-env` are refused with `local/...`; `--stock` works (the route is only the endpoint declaration). `steak-dsh models` lists `local/<id>` for each profile file; `steak-dsh doctor` reports whether `steak-pi` was found.

## Checks and profiles

`--verify "npm test"` runs your check after an edit. After two consecutive failures,
verification pauses until the next request. Persistent project settings belong in
`$DSH_HOME/steak-dsh.json` (default `~/.dsh/steak-dsh.json`):

```json
{ "projects": { "/abs/path/to/project": { "verify": { "command": "npm test", "failLimit": 2, "timeoutMs": 90000 } } } }
```

The same file can hold per-model guidance: `{ "modelGuidance": [{ "match": "^provider-a/", "text": "..." }] }` adds each line to the system prompt only on steps whose provider/model matches (case-insensitive). The bundle ships no rule.

A project's `.steak-dsh/config.json` is read only if the project is listed under
`"trusted"` in that user configuration.
See [profiles](docs/profiles.md) for the bundle switches and `--long`,
[terminal UI](docs/terminal.md) for keys and rendered examples, and [security](SECURITY.md)
for the trust boundary. `steak-dsh --help` is the flag reference.

## Recorded benchmarks

These are historical **0.1.0** results, not measurements of the current release.
The checked-in rows cover 20 small Python tasks, five repeats per arm. All 100 runs
succeeded for both stock dsh and Steak DSH on each model below.

| Model | Steak DSH / stock dsh cost | 95% bootstrap interval |
|---|---|---|
| [DeepSeek V4.1 Flash](benchmarks/results/2026-11-11-deepseek-v4.1-flash.jsonl) | 0.84 | 0.76–0.93 |
| [Qwen 4 Max](benchmarks/results/2026-11-11-qwen4-max.jsonl) (weighted tokens, not dollars) | 0.70 | 0.62–0.78 |

Recompute from this repository without model access:

```sh
python3 benchmarks/summarize.py benchmarks/results/2026-11-11-deepseek-v4.1-flash.jsonl --md
python3 benchmarks/summarize.py benchmarks/results/2026-11-11-qwen4-max.jsonl --md
```

Each command overwrites `summary.json` beside its input. These tasks do not establish
large-project performance or a current-version saving. The sample was extended after
an initial look; see [the gate](GATE.md). See [benchmark instructions](benchmarks/README.md)
for fixtures, prices, weighting and paid reruns.

## Development

No dependency install or compilation is needed:

```sh
npm test
python3 benchmarks/selftest.py
```

See [contributing](CONTRIBUTING.md) and [changelog](CHANGELOG.md).

Part of [Pareto Cybernetics](https://paretocybernetics.com): free, private, open-source tools for working with AI agents.
