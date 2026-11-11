# Changelog

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
