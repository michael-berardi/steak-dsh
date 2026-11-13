# Changelog

## 0.7.1 - 2026-11-13

- Models on the `claude-code` route were offered with a 200K context window although they run with 1M: the CLI's model
  list states no window, and the route fell back to the small default. The window now comes from the harness's own
  model catalog, and after the first reply from the figure the CLI reports for the model it ran. The context meter and
  compaction use the real size.
- The cost in the status band was always `$0.000` on the two login routes. It now shows the list price of the work:
  the figure the CLI reports for each request on `claude-code`, and tokens times the catalog price otherwise. A login
  route whose model the catalog does not list still shows `$0.000`.

## 0.7.0 - 2026-11-13

- The terminal UI has room at the top: one blank row above the header and one between the header and the first
  message. Panes under 12 rows keep the compact layout.
- An empty session no longer shows three lines of intro text (folder and session id, "Type a message…", the key
  list). The transcript area is empty until you send something. `/help` still lists keys and commands.
- The status band now ends with the session's cost, like Steak Pi: tokens times the model's price in the harness's
  model catalog, with cache reads and writes at their own rates. The `claude-code` and `openai-codex` login routes are
  billed to your plan and show `$0.000`. A route with no known price (a gateway declared with `--base-url`) shows no
  cost instead of a guess. `/new` resets it.
- A message sent in the first seconds, before the harness had finished starting, failed with "send failed: SDK server
  is not initialized". It now waits for the harness and is sent.

## 0.6.0 - 2026-11-12

- New model route `openai-codex`: requests go to the Codex Responses endpoint on your ChatGPT plan, with the login the
  official Codex CLI keeps (`auth.json` in `$CODEX_HOME`, default `~/.codex`). The route adds no wire code: it runs
  dsh's own Codex transport and supplies the token, read at request time and never printed, logged or put in the
  environment. An expired token is renewed with the refresh token and the renewed login is written back to the same
  file in the CLI's format. No login fails with `CODEX_NOT_LOGGED_IN`, a refused renewal with `CODEX_TOKEN_EXPIRED`.
  The route never uses an API key; a Codex CLI in API-key mode is refused. Module in `codex/`.
- The route's models are the ones the Codex backend lists for your account, asked at runtime, with their context size
  and effort levels. Nothing is listed in the bundle; a test fails if a shipped file names a model.
- `steak-dsh run|chat|tui --model openai-codex/<model>` works without `--base-url` or a key; `--stock` refuses it.
- New command `steak-dsh models [--json] [--provider <name>]`: prints every model the `claude-code` and `openai-codex`
  routes offer right now, one `provider/model-id` per line. `scripts/compare-with-steak-pi.mjs` compares that list
  with `steak-pi --list-models`.
- Fixed: the `claude-code` route offered only part of the login's models. The model list was asked with the
  quiet-network switches the route sets on requests, and with either set the CLI answers from a short built-in list
  (5 rows instead of 14 on CLI 2.1.322). The list is now asked without those two switches; requests keep them.
- Changed: `claude-code` rows are offered under the full model id the CLI resolves them to, the form Steak Pi lists,
  and go to the CLI under the CLI's own name for the row. The CLI's short names still work as typed ids.

## 0.5.0 - 2026-11-12

- One bundle, one profile. A new tool, `more_tools` (plugin `steak-more-tools`), costs about 250 bytes on the first
  request. When the model calls it, the subagent tool, its follow-up tool and the working-directory switch are switched
  on through the loader and are in the next request, with the spill budget `--long` used. Deferred tool loading was not
  used: the OpenAI-compatible adapter drops tools marked deferred.
- The finish guard is on by default (it acts only on open todo items or a reply reporting unfinished work, at most 3
  times, never on subagent children, and costs no tool text).
- `--long` is still accepted and still works; it is now only a preload of the same rows before the first request.
  `long.patch.yml` no longer carries the finish guard row, since the bundle has it on. `--stock` is unchanged.
- Measured with ParetoBench on one model, 3 repeats, paired, 95% intervals, against the 0.4.0 bundle: 20 short tasks
  cost 1.03 times (0.92 to 1.16), no clear difference, 60 of 60 correct (0.4.0 got 59 of 60); 11 long tasks cost 1.04
  times (0.88 to 1.19), no clear difference, 33 of 33 correct on both. So the one extra tool costs nothing measurable.
- Not shown: in those runs the model never called `more_tools` and the finish guard never acted, so they show no harm,
  not a benefit. In a live check a prompt that asked for a subagent called `more_tools`, then `subagent`, and answered
  correctly with no flag. The switch lasts for one dsh process: a resumed session offers `more_tools` again.

## 0.4.0 - 2026-11-12

- New model route `claude-code`: requests run through the official Claude Code command on your own subscription login,
  while dsh keeps the conversation, the tools and the approvals. A port of Steak Pi's Claude Code module to dsh's message
  and stream types, in `claude-code/` with its upstream licence notice. Models are discovered from the installed CLI; with
  no CLI or no login the route offers none and a request fails with a named error. Inherited API-key, proxy, Bedrock,
  Vertex and Foundry overrides are refused, a turn charged to usage credits fails with a non-retryable billing error
  unless `STEAK_DSH_CLAUDE_CODE_ALLOW_USAGE_CREDITS=1`, Claude Code can ask for a tool but never run one, one upstream
  request per harness turn, and an aborted request stops the whole process tree.
- `steak-dsh run|chat|tui --model claude-code/<model>` works without `--base-url` or a key; `--stock` still leaves the
  bundle out and refuses that model.
- Checked on one machine with Claude Code 2.1.322: an answer-only task and a file edit through the harness's own tools
  both completed, with cache reads growing across steps. Not yet tested: Windows, other Claude Code versions, the
  terminal UI on this route, long conversations, images (the route is text only), and the usage-credit guard against
  the real service (it is tested against a scripted one).

## 0.3.3 - 2026-11-12

- The working rules (`plugins/rules.js`) gain one line asking the model to keep its reasoning short, pick the next step
  and not narrate between tool calls. Measured with ParetoBench on one model, paired, 95% intervals, every run correct
  in every arm:
  - 20 short tasks, 3 repeats: cost 0.83 times the 0.3.1 bundle (0.75 to 0.91) and 0.64 times stock `dsh`
    (0.53 to 0.78).
  - 11 long tasks, 3 repeats: cost 0.69 times stock `dsh` (0.63 to 0.77), 33 of 33 correct.
  No tool, plugin or safety row changed. The `--long` profile inherits the line and was not benchmarked with it.
  Tried and dropped, because no run showed a gain: removing the todo, skill, web, search and image tool schemas.

## 0.3.2 - 2026-11-12

Fixes to `steak-dsh tui` on a real harness.

- Tool cards showed `✓ undefined` with no arguments, output or diff, and the status band never showed context,
  tokens or cache share. The SDK wire wraps each event's fields in `data`; the UI read them from the top level, which
  only the scripted test sessions used. Both shapes are now read the same way, and a test replays the recorded
  wire shape.
- File paths inside the working directory are shown relative to it in tool cards and diff headers
  (`src/slug.js`, not the full absolute path). Paths outside it are unchanged.

## 0.3.1 - 2026-11-12

Fixes to the one-step installers.

- Windows: `install.ps1` no longer rewrites your whole user Path with expanded values. Before, adding the bin folder
  turned entries such as `%USERPROFILE%\AppData\Local\Microsoft\WindowsApps` into fixed paths and changed the
  value's type so `%VAR%` entries stopped working. It now reads the raw value, appends only when the folder is
  missing, and keeps the existing type.
- Both installers: an unmarked `steak-dsh` file is treated as an older shim only when it is a regular file (not a
  symlink, such as one from `npm -g`) with the exact 0.2.0 shim shape. Before, any file naming `STEAK_DSH_DSH_BIN`,
  including a symlink to a real launcher, could be replaced.
- `build-release.sh` no longer hides a failing `tar` behind a pipe.

## 0.3.0 - 2026-11-12

- `steak-dsh tui`: a full-screen terminal UI close to the Steak Pi one. One long-lived `dsh --profile sdk` child over
  JSON-RPC on stdio, the same overlay patches as `run` and `chat` (including `--long`). Header, transcript with
  thinking blocks, tool cards (pending, success, error) and numbered coloured diffs, a status band (state, model,
  effort, context meter, tokens, cache share), approval and question selectors that fail closed when the harness
  dies, a multi-line editor with history, kill keys and bracketed paste, Esc to interrupt (stop, respawn, resume),
  resize, `NO_COLOR` and a plain line mode on a pipe. Node built-ins only. Needs `--model`. Text arrives per committed
  step (the SDK wire has no token stream); there is no cost figure; `--add-dir` has no effect on this wire.

## 0.2.1 - 2026-11-11

Fixes to the one-step installers shipped in 0.2.0.

- The installers no longer replace a `dsh` or `steak-dsh` file that they did not write. Their own shims now carry a
  marker line; a file without it is left alone with a one-line note. Before, a `dsh` of your own in the install
  `bin` folder was overwritten when that folder was not on PATH. Shims from 0.2.0 are still recognised and upgraded.
- `install.sh`: a private Node that exists but does not run is now replaced instead of making every re-run fail; the
  "added Steak DSH to it" line is printed only when adding to the dsh headless profile worked.
- `install.ps1` (Windows): shims use paths relative to themselves, or the OEM code page for an absolute path, so a
  profile folder with accented characters works; the release is unpacked straight into the install folder (a move
  from the temp drive failed across drives); a relative or forward-slash `STEAK_DSH_HOME` no longer deletes the
  release just installed; a broken `current` junction is replaced; npm is taken from PATH when no `npm.cmd` sits
  beside `node.exe`; TLS 1.2 is enabled and the progress bar silenced on Windows PowerShell 5.1; the session's
  error preference, variables and PATH are left as they were.
- `scripts/build-release.sh` refuses an empty output folder, `.`, `/`, or the repository root, and compresses with
  `gzip -n` on every platform.
- The Windows installer was tested under PowerShell 7 on Linux and not yet on a Windows machine.

## 0.2.0 - 2026-11-11

- One-step installers: `install.sh` (macOS and Linux) and `install.ps1` (Windows, also runs under PowerShell 7 on
  Linux) download the release, check its SHA-256, bring Node 22 and DeepSeek Harness when missing, add the bundle
  to the dsh headless profile, and finish with `steak-dsh doctor`. `scripts/build-release.sh` builds the release
  assets; `scripts/test-install.sh` tests both dsh branches on macOS, in an Ubuntu container, and under pwsh.
- `--long` (run and chat): a long-work profile, shipped as `long.patch.yml` and applied right after the bundle. It
  gives back the subagent tool, its follow-up tool and the working-directory switch, turns the finish guard on and
  states the spill budget. The default profile is unchanged: without the flag nothing extra is passed. Refused with
  `--stock`. A direct `dsh` run uses the same file with one more `--patch`.
- Finish guard: a subagent child is no longer pushed (the guard was documented that way but pushed every agent).
  `subagents: true` on the row restores the old behaviour.

## 0.1.2 - 2026-11-11

Fixes from an independent review of 0.1.1.

- Task text can no longer be read as `dsh` flags: the launcher passes it after `--`.
- `run` forwards hangup and quit signals, and `chat` handles termination signals: the child is stopped and the
  temporary overlay removed.
- Verify after edit: a cancelled check is not counted as a failure. After two failures in a row it pauses for the
  rest of that request and says so, then starts again on your next request. A check command that leaves a background
  process no longer waits for the timeout.
- `--stock` with `--verify`, and `--effort level=wire` without `--base-url`, are refused by name.
- Finish guard: reads only the current request, and recognises more ways of saying stop.
- Owned paths: an owned filesystem root now contains everything.
- README: the first DeepSeek V4.1 Flash run (0.84) is the headline, the second run (0.92) is stated as not clear on
  its own, and the pooled figure is labelled as chosen afterwards. Ablation results for both models are listed.

## 0.1.1 - 2026-11-11

- README: results of a second, independent run with stock Pi added (ParetoBench). Steak DSH against stock DSH on
  DeepSeek V4.1 Flash is 0.87 (0.80 to 0.94) over 160 pairs; stock Pi was the cheapest harness on these short tasks.
- Launcher: `--effort <level>=<wire>` for gateways that spell an effort level differently. Compat switches DSH refuses
  on a declared route are left out with a note instead of failing the run.
- The benchmark lives in `benchmarks/` and reads executables from PATH and the environment.

## 0.1.0 - 2026-11-11

First release. Built and measured against DeepSeek Harness 0.2.2-rc.1.

- Bundle for `dsh`: a leaner tool set for one-shot coding tasks, a short set of working rules, verify-after-edit,
  and a finish guard (shipped off).
- `steak-dsh` launcher: `run`, `chat`, `install`, `doctor`, with the model chosen by flags.
- Owned paths: file edits outside the paths a task owns are refused.
- Benchmark: 20 tasks with scripted checkers, stock DSH against Steak DSH, Steak Pi and Claude Code on the same model.
