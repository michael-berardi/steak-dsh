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
npm i -g github:michael-berardi/steak-dsh#v0.11.1
```

Or add only the plugin to a profile:

```sh
dsh plugin --profile headless add github:michael-berardi/steak-dsh#v0.11.1
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

`run` emits text or, with `--json`, dsh NDJSON. `chat` is line-based; `tui` is full-screen
and requires `--model`. Only the TUI can answer approval prompts; `run` and `chat`
refuse requests needing approval even with `--approval-policy ask`.
`--add-dir` does not work over the TUI's SDK connection.

For a gateway, pass `--model provider/model`, `--base-url`, `--api` and `--key-env`.
The API is `openai-completions`, `openai-responses` or `anthropic-messages`.
`--key-env` takes an environment variable name, never the key itself.
`--effort` controls reasoning; `--stock` omits the bundle for comparisons.

Two optional login-backed routes are included:

- `claude-code/<model>` uses the installed Claude Code CLI and its login. Authenticate
  with `claude auth login`. API-key and alternative-billing environment settings are
  refused; usage credits require `STEAK_DSH_CLAUDE_CODE_ALLOW_USAGE_CREDITS=1`.
- `openai-codex/<model>` uses the Codex CLI's file login and dsh's Codex transport.
  Authenticate with `codex login`; keyring-only storage is not supported. Token renewal
  writes the refreshed login back to `auth.json`.

Both routes are text-only, need no gateway flags and cannot be used with `--stock`.
`steak-dsh models` lists their available models; `--json --provider openai-codex`
filters machine-readable output. A failed route reports an error and exit status 1.

A third, optional route runs on a Google Antigravity sign-in. It is **off until you turn it
on**, ships no model, no OAuth client and no account, and with no config file loads nothing.

1. Create `$DSH_HOME/steak-dsh-antigravity.json` (default `~/.dsh/steak-dsh-antigravity.json`) and `chmod 600` it:
   `{ "enabled": true, "clientId": "<your OAuth client id>", "clientSecret": "<your OAuth client secret>" }`.
   The client is one you are allowed to use with the service; Steak DSH does not ship one.
2. `steak-dsh antigravity login` prints a Google sign-in address, captures the loopback callback
   (or asks you to paste the callback URL on a remote machine) and saves the sign-in, owner-only, in
   `$DSH_HOME/steak-dsh-antigravity-auth.json`. `steak-dsh antigravity status` and `logout` do what they say.
3. `steak-dsh models --provider antigravity` lists what your account offers (the list comes from the service),
   and `steak-dsh run --model antigravity/<model-id> ...` uses one. (Steak Pi's `steak-dsh/<provider>/<model-id>`
   dispatch declares gateway routes with an API key; it does not run the login-backed routes, so use this one from
   the `steak-dsh` command.)

Optional config keys: `baseUrls` (https; tried in order only when one cannot be reached before the request body had
finished uploading; a request that was sent, or that got any answer including a 5xx, is not sent to another endpoint),
`authUrl`, `tokenUrl`, `scopes` (default: `aicode`, `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`,
`experimentsandconfigs`; configurable, and whether the last two are needed is not verified),
`redirectPort` (default 51121, must match the client's registered redirect), `userAgent` (sent as the `User-Agent`
header and as `userAgent` in the request envelope), `requestType` (default `"agent"`, sent in the envelope),
`ideType` (default `"ANTIGRAVITY"`, sent in the project lookup; so by default the project lookup does name that
client family, and the service may refuse other values), `projectId`,
`maxRateLimitWaitMs` (default 30000) and `maxRateLimitRetries` (default 2). The route is text-only (an image is
named in text, as on the other routes). Named failures: no client in config, a refused refresh (sign in again),
a 401 (one refresh, one resend, then named), 403, a 429 (waits at most the bound, then says when to retry), a silent
connection, a stalled upload (not sent again) and a stream cut without a finish reason. Nothing falls back quietly.
While the route is on, a config file that other users can write or that another user owns is refused (the error
gives the `chmod`/`chown`), as is one holding a client secret that others can read. A callback with a missing or
wrong state is answered 400 and ignored, so nothing but the real callback can end a sign-in; text from a callback
or a provider is shown without control characters. A network failure while refreshing says the token endpoint cannot
be reached; it does not call the sign-in invalid. One stream line over 16 MiB, an error or token reply over 1 MiB and
a model list over 8 MiB end the request with a `protocol` error. `antigravity status` reads the saved file only: it
says "not expired locally" and does not call Google or rewrite the file.
With the route off the cost is one failed file read. See the 0.11.0 and 0.11.1 changelog entries for what was verified.

## Checks and profiles

`--verify "npm test"` runs your check after an edit. After two consecutive failures,
verification pauses until the next request. Persistent project settings belong in
`$DSH_HOME/steak-dsh.json` (default `~/.dsh/steak-dsh.json`):

```json
{ "projects": { "/abs/path/to/project": { "verify": { "command": "npm test", "failLimit": 2, "timeoutMs": 90000 } } } }
```

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
