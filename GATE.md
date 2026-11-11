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

## Amendment, 2026-11-11, written after the first look and before any further run

First look at the release configuration, 2 repeats (40 pairs) on the `deepseek` key: correct 40/40 for both arms,
cost ratio `sdsh / dsh` 0.89, 95% interval 0.78 to 1.02. Condition 2 fails on that sample because the interval
reaches 1.00. An earlier 2-repeat sample of the same behaviour gave 0.82 (0.72 to 0.93); it was run with a since
changed default (finish guard on, though it never acted) and at the same time as another runner, so it is not counted.

Two repeats are too few to settle an effect of this size. The sample is extended once, to a fixed 5 repeats per model
(100 pairs) for both the `deepseek` and `qwen` keys, with the bundle unchanged. The verdict uses all 5 repeats,
including the 2 already run. No further extension, and no change to the bundle between repeats. The README reports
the 5-repeat numbers whatever they are, and says the sample was extended after a first look.
