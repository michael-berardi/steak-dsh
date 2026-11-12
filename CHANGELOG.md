# Changelog

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
