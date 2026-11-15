# Changelog

## 0.10.3 - 2026-11-15

- **README:** 597 lines to 153. It leads with what the bundle adds and the one-line install; the reference material moved to `docs/`, which now ships in the package and the release archive.
- The benchmark claims on the front page are limited to the two ratios that the result files in this repository reproduce.
- Corrected: the supported `dsh` range, what the approval settings cover, and the finish-guard description.

## 0.10.2 - 2026-11-14

- **Runs start about 100 ms sooner.** The launcher used to start the harness once just to read its version (about 65 ms)
  before starting it again for the task; it now reads the version from the installed package and only asks the binary
  when it is not that package. The harness also starts with Node's compile cache, so its several hundred modules are not
  compiled again on every run. Measured on a scripted three-request run against a local endpoint, 15 paired runs:
  launch to first model request 835 ms to 727 ms, whole run 937 ms to 838 ms. Nothing else about a run changes.
- `STEAK_DSH_COMPILE_CACHE=0` turns the compile cache off; a `NODE_COMPILE_CACHE` already set is kept.

## 0.10.1 - 2026-11-14

- The finish guard is checked against the harness's own todo tool. A test runs the real harness with a scripted model
  that calls `todo_write` with an open item and then stops: the guard keeps the turn open three times and then lets it
  end, and a completed list ends at once. It behaves the same in `run`, `chat` and `tui`.
- The terminal UI says when the guard pushes: one line such as `finish guard push 1/3: the turn was about to end with
  2 open todo items; the agent was told to keep going`. Before, the agent just seemed to carry on.
- The guard recognises more wordings of unfinished work, reads a reply whose content is a plain string, stands down for
  a question-only request or an explicit hold, and no longer treats any mention of "approval" in a blocked item's
  reason as a real outside blocker.
- `STEAK_DSH_FINISH_GUARD=0` turns the guard off without editing a patch file.

## 0.10.0

- The default permission changed from `workspace-write` to `danger-full-access`: commands run without a sandbox or approval prompts. Use `--permission workspace-write` for the old behaviour.
- The terminal UI status band no longer displays the permission preset or approval policy. An open approval still shows its waiting state.

## 0.9.0 - 2026-11-14

- The terminal UI could lose a session for good. Its harness child is started with a generated overlay file in the
  temp folder. If that file was removed while the session ran, every restart died at boot with "dsh: failed to read
  overlay ... ENOENT", wrote nothing to the session, and the notice showed only the last stderr line, Node's version
  banner (`harness exited with code 1 (Node.js v22.22.2)`). Each message restarted it and it died again. Now the
  overlay is written again, in a fresh temp folder, before every spawn (`tui` restarts and every `chat` turn), and a
  missing `--patch` file is named instead.
- A harness that exits on its own is reported with its cause: the exit code, the phase (startup or resume), the first
  error line of its stderr and the top stack frame. The whole stderr tail (up to 64 KiB, it used to be 2000 characters)
  goes to `$DSH_HOME/steak-dsh/logs/harness-exit-<time>-<pid>-<n>.log`, `0600` in a `0700` folder, and the notice
  names the file. The same death no longer adds a second "send failed: harness closed the connection" line.
- Crash loop guard: when the harness fails the same way twice in a row on one session, with no finished turn in
  between, the terminal UI stops restarting it. It says so with the cause, keeps the session id on screen, and
  offers `/new`. `/resume <id>` tries the old session again; that retry never resumes the failing session first.
- New option `--approval-policy <never|ask>`, named as in dsh, for `run`, `chat` and `tui`. `never` is the default
  everywhere, which `run` and `chat` already did. `tui` used to ask about every sandbox escalation, and in the
  default `workspace-write` sandbox ordinary commands (`ps`, `git fetch`, reading files another process wrote, a tool
  with its own sandbox) need one, so a long session asked again and again. Over the SDK wire the policy is carried by
  the permission preset: the tui overlay rewrites the preset table with the chosen policy and makes `--permission` the
  default preset of every new session. `/permission <preset>` is sent before the first prompt of every session and
  after every restart and `/resume`. A preset typed in the session is kept across restarts and `/new`.
  `--permission danger-full-access` means no sandbox and no prompts. The sandboxed default can do no more than before.
- New bundle plugin `approval-never.js`: under policy `never`, a call that asks for a wider sandbox is refused before
  it runs. The reason names the policy, the current preset and the preset (`--permission ...`, or `/permission ...`
  in the terminal UI) that would allow it. The harness alone would say "the user rejected" though nobody was asked.
  It does nothing under `ask`.
- With `--approval-policy ask`, the approval selector offers `Allow for this session` (key `a`) beside `Allow once`
  and `Reject`. The SDK approval reply has only a one-time grant, so the terminal UI keeps the rule itself. Until
  you quit it answers identical requests (same session, tool and sandbox mode), including ones already queued, and
  shows a line for each.
- The status band shows the preset and approval policy in force (`workspace-write · approval never`, `ww/never` when
  narrow). An open prompt shows `◇ waiting · <tool> · since HH:MM`. An answer given after the harness died is never
  delivered to the restarted one.
- Tests: the `claude-code` and `codex` end-to-end tests ran the real `dsh` against your own `$DSH_HOME` and left test
  sessions in your session store. They now use a scratch home. The transcript-publisher tests left about 36
  `steak-dsh-*` folders in the temp folder per run, and the TUI host test one more. They now remove them, and the fake
  harness uses one exit listener instead of one per fake.

## 0.8.0 - 2026-11-13

- The terminal UI can publish its conversation for a host app to show in its own view. With `ULTRATERM_UI_TRANSCRIPT_FILE`
  and `ULTRATERM_UI_SESSION_ID` set it writes a Pi-format session log (user messages, assistant text, tool calls and
  results, a stop row per turn, token usage and cost); the file is `0600` in a `0700` folder, never follows a symlink,
  and a write error stops publishing with one notice instead of interrupting the session. `/new` and `/resume` start a
  fresh file. Without the variables nothing is written. See "Showing the conversation in a host app" in the README.
- Hardening of that file: the three host variables are removed from the environment of the harness child and every
  tool it runs, so a nested `steak-dsh tui` publishes nothing; the file is created at start with an exclusive,
  no-follow create and an existing file is refused; the session id must be a lowercase uuid and no folder is created
  recursively; the `/new` temp file has a random name and is only removed when this process made it; every append
  checks the file's device and inode, and a deleted or replaced file stops publishing without writing to the other
  file; a write error appends one final `error` row, and `/new` resumes publishing; each text field is cut at
  262144 characters; tool arguments with `file_path` also carry `path`. The README now says the file holds full tool
  arguments and results, gives the host manifest snippet, and names the stop reasons (`stop`, `error`, `aborted`).
- After a second review of that file: a publisher whose start was refused (the file already existed) no longer
  replaces the file on `/new`, and `/new` leaves a foreign file at the path alone; a write that stops part-way is
  rolled back so no partial line stays; a failed `/new` keeps row ids unique; a cut never splits a character and a
  lone surrogate is never written; a row over 4 MiB is written with its texts and tool arguments replaced by
  `[truncated]`.
- After a third review: `/new` in a transcript folder that stopped being private stops publishing with a notice
  instead of appending the new conversation to the old file; a start that fails after creating the file removes it.
- The installers try a download again when the connection drops part-way (up to 4 tries, with a line saying so). One
  dropped connection while fetching Node used to fail the whole install. An HTTP error from the server is not retried.
- `ULTRATERM_MAIN_SCREEN=1` keeps the terminal UI on the main screen instead of the alternate screen. Without it the
  bytes written are unchanged.

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
