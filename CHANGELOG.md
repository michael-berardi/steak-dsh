# Changelog

## Unreleased

- One-step installers: `install.sh` (macOS and Linux) and `install.ps1` (Windows, also runs under PowerShell 7 on
  Linux) download the release, check its SHA-256, bring Node 22 and DeepSeek Harness when missing, add the bundle
  to the dsh headless profile, and finish with `steak-dsh doctor`. `scripts/build-release.sh` builds the release
  assets; `scripts/test-install.sh` tests both dsh branches on macOS, in an Ubuntu container, and under pwsh.
- `--long` (run and chat): a long-work profile. It gives back the subagent tool, its follow-up tool and the
  working-directory switch, turns the finish guard on and states the spill budget. The default profile is unchanged:
  without the flag no extra row is generated. Refused with `--stock`.
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
