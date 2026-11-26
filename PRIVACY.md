# Privacy

Steak DSH is a local launcher and plugin bundle for DeepSeek Harness (`dsh`). Its own code ships no analytics SDK, telemetry endpoint, error reporter, update checker or update prompt, and it sends no usage, crash or diagnostic reports. The only network traffic Steak DSH itself starts is the provider and installer traffic listed below; the CLI tools and models you choose follow their own settings.

## Network egress

- **Model requests.** Prompts, file contents and tool results go to the provider for the model you chose: the gateway passed with `--base-url`, your own local server for `local/<id>`, your signed-in Claude Code CLI for `claude-code/<model>`, OpenAI's ChatGPT backend (`https://chatgpt.com/backend-api`) for `openai-codex/<model>`, using the login your Codex CLI saved in `$CODEX_HOME/auth.json` (Steak DSH calls the backend itself and does not start the Codex CLI), or your signed-in `agy` for `agy/<id>`. That provider receives what you send it. Keys come from the environment variable named by `--key-env` or from the CLI's own login; Steak DSH never prints them.
- **Codex token refresh.** An expired Codex file login is renewed with a refresh-token POST to `https://auth.openai.com/oauth/token`, the same request the Codex CLI makes. When the refresh token rotates, the renewed login is written back to the Codex CLI's own `auth.json`. No other route reads or copies a CLI credential.
- **Model listing.** `steak-dsh models` asks those same sources what they offer. The Claude Code route uses the CLI's built-in catalog and keeps the CLI's telemetry switches on; an explicit `claude-code/<model>` id is still sent to the CLI even when it is not listed.
- **Installer downloads.** Running an installer downloads the release archive and its SHA-256 checksums from GitHub, and, only when needed, official Node binaries from nodejs.org (checksum-verified) and packages from the npm registry. Nothing else in normal use makes a network call from Steak DSH code.
- **No automatic updates.** There is no daily or other automatic update check to opt in or out of, and no update prompt. Both installers set `npm_config_update_notifier=false` for the npm/corepack processes they start. Re-running an installer is the explicit way to update.

## Telemetry switches

- The launcher forces `DSH_TELEMETRY_MODE=DISABLED` and `DO_NOT_TRACK=1` on every dsh process it starts, including `dsh plugin`; an inherited value cannot turn telemetry back on.
- The Claude Code route keeps `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING` and `DO_NOT_TRACK` enabled on every CLI process, including `auth status` and model discovery.
- The agy ACP transport passes `--disable-telemetry`; its log file lives in a private per-session folder.
- Both installers set `DO_NOT_TRACK=1` and `DSH_TELEMETRY_MODE=DISABLED` for the npm, corepack and dsh processes they start, and restore the caller's values afterwards.
- Host-app variables (`ULTRATERM_UI_TRANSCRIPT_FILE`, `ULTRATERM_UI_SESSION_ID`, `ULTRATERM_MAIN_SCREEN`) are removed from every child process.

## Local writes

Every file or folder Steak DSH creates has a stated lifetime and either automatic cleanup/retention or a manual deletion step. `$DSH_HOME` defaults to `~/.dsh`; `$XDG_CACHE_HOME` defaults to `~/.cache`.

| Location | Contents | Lifetime and automatic cleanup / retention | How to delete |
|---|---|---|---|
| `$DSH_HOME/steak-dsh/logs/harness-exit-*.log` (TUI only) | Harness stderr tail (last 64 KiB) plus exit code, time, session id, command and cwd; can include session text. Mode 0600 in a 0700 folder. | Kept until pruned after each new log: only the newest **20** files survive. Older logs are unlinked automatically. | `rm -rf "$DSH_HOME/steak-dsh/logs"` |
| `$XDG_CACHE_HOME/steak-dsh/compile-cache` (or `~/.cache/steak-dsh/compile-cache`) | Node's compiled-code cache for the harness, keyed by code content; no prompts or tokens. 0700 folder, 0600 entries. | Pruned on every launcher start: entries older than **30 days** or beyond **4096 files** (oldest first) are removed, as are empty version folders. `STEAK_DSH_COMPILE_CACHE=0` creates nothing and a caller's own `NODE_COMPILE_CACHE` is never pruned by us. | `rm -rf "$XDG_CACHE_HOME/steak-dsh/compile-cache"`; disable with `STEAK_DSH_COMPILE_CACHE=0` |
| Generated overlay YAML in the OS temp folder (`steak-dsh-*`) | Route, permission, verify and owned-path patch rows for one run or session. One 0600 file in a private 0700 `mkdtemp` folder. | Removed when the run or session exits (also on `exit`/signal), and the previous copy is removed on a live `/model` switch. A crash leaves it for the OS temp cleaner. | `rm -rf /path/to/steak-dsh-<random>` if a crash left one behind |
| Claude Code transport folder in the OS temp folder (`steak-dsh-claude-code-*`) | `tools.json`, `settings.json` and `system.md` for one CLI process. | Removed when that CLI process closes or on any start/error path; a crash leaves it for the OS temp cleaner. | `rm -rf /path/to/steak-dsh-claude-code-<random>` |
| `$DSH_HOME/steak-dsh-acp-*` (agy ACP only) | Minimal bridge agent config and the private `acp-*.log` for one ACP session. | Removed when the session closes; a hard crash can leave one folder, which is not reused. | `rm -rf "$DSH_HOME"/steak-dsh-acp-*` |
| `$CODEX_HOME/auth.json.steak-dsh-<pid>.tmp` (default `~/.codex`) | Temporary copy of a renewed Codex login while it is atomically renamed into place. Mode 0600. | Removed immediately after the rename or on any write error; a hard crash can leave one file per interrupted renewal. Your `auth.json` itself is owned by the Codex CLI. | `rm -f "$CODEX_HOME"/auth.json.steak-dsh-*.tmp` |
| File named by `ULTRATERM_UI_TRANSCRIPT_FILE` (TUI only, host opt-in) | JSONL conversation published to a host terminal: user, assistant, tool-call and tool-result rows; reasoning text is excluded. Each text is capped at 256 KiB and each row at 4 MiB. Mode 0600 in a 0700 folder. | Created only when a host sets both this variable and a UUID `ULTRATERM_UI_SESSION_ID` (and the path ends in `<id>.jsonl`); one session per file, replaced on `/new` or `/resume`. The host owns the file's retention. Those variables are stripped from every child process. | Delete the session file the host created, for example `rm "$ULTRATERM_UI_TRANSCRIPT_FILE"` |
| `$DSH_HOME/steak-dsh.json` (user config/state) | Trusted project paths, verify commands and per-model guidance. Steak DSH only **reads** it; it does not write it. | One file, retained until you change or remove it. | `rm "$DSH_HOME/steak-dsh.json"` |
| Session history under `$DSH_HOME` | Conversation/session state kept by the installed `dsh`, not by this bundle. | Retained under dsh's own policy; the launcher does not add to it directly. | Use dsh's own session commands, or `rm -rf "$DSH_HOME"` |
| Installer files under `~/.steak-dsh` (`%LOCALAPPDATA%\steak-dsh` on Windows) and shims under `~/.local/bin` | Release copies (`app/release-<version>` with `app/current`), private Node and dsh when needed, and command shims. | Re-running an installer replaces the private Node/dsh and deletes previous release folders. Installer temp folders are removed by an `EXIT` trap (POSIX) or `finally` block (Windows). | Follow the removal steps under [Install](README.md#install) |

## Uninstall

Delete the install directory and command shims as described in [Install](README.md#install), and remove `dsh plugin --profile headless add steak-dsh` with `dsh plugin --profile headless remove steak-dsh` if you added the bundle. Remove `$DSH_HOME` and the compile cache folder above for local data. Login and sign-in data kept by the Claude Code, Codex or agy CLIs belongs to those tools; remove it with their own logout commands.
