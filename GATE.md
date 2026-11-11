# Gate: when Steak DSH counts as better

Written 2026-11-11, before any comparison run.

Arms, same model, same tasks, same checker, same effort, fresh fixture per run:

- `dsh`: stock DeepSeek Harness (`@deepseek-ai/dsh`, latest published), headless profile, no changes.
- `sdsh`: the same DSH build with the Steak DSH bundle added.
- `sp`: Steak Pi, stock config.
- `cc`: Claude Code, stock config (Claude models only, so it is compared on its own model and labelled as such).

Measures per run: correct (scripted checker), input, cached input, output tokens, turns, wall seconds. Cost comes from one
rate table applied to every arm.

Steak DSH is "better than stock DSH" only if all three hold on the full task set:

1. Correct runs: no fewer than stock DSH.
2. Cost per correct run: paired ratio `sdsh / dsh` below 1.00 with the 95% bootstrap interval below 1.00,
   or correct runs higher by at least 2 with cost ratio not above 1.05.
3. No task where `sdsh` fails every repeat and `dsh` passes every repeat.

Steak DSH goes ahead of Steak Pi in a router class only if, on that model, it has no fewer correct runs and a lower cost per
correct run with the 95% interval below 1.00. Otherwise the router keeps both and ranks them on live evidence.

Each Steak DSH feature is kept only if removing it makes condition 1 or 2 worse on the tasks it targets; a feature that
shows no effect is removed or shipped off by default.

Failures, timeouts and harness errors stay in the sample as incorrect runs. Raw per-run rows are published.
