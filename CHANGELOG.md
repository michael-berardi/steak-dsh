# Changelog

## 0.1.0 - 2026-11-11

First release. Built and measured against DeepSeek Harness 0.2.2-rc.1.

- Bundle for `dsh`: a leaner tool set for one-shot coding tasks, a short set of working rules, verify-after-edit,
  and a finish guard (shipped off).
- `steak-dsh` launcher: `run`, `chat`, `install`, `doctor`, with the model chosen by flags.
- Owned paths: file edits outside the paths a task owns are refused.
- Benchmark: 20 tasks with scripted checkers, stock DSH against Steak DSH, Steak Pi and Claude Code on the same model.
