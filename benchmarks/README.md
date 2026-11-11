# steak-dsh bench

Compares coding-agent harnesses on identical small tasks with the same model: stock DeepSeek Harness
(`dsh`), DeepSeek Harness plus the Steak DSH bundle (`sdsh`), ablation variants of `dsh`, Steak Pi
(`sp`) and Claude Code (`cc`). Python 3 standard library only; no dependencies.

## What is measured

Per run: correct (a scripted checker, `checks/check.py`), uncached input tokens, cache-read and
cache-write tokens, output tokens, reasoning tokens, turns, tool calls, wall seconds, retries and
errors. Cost is computed by `summarize.py` from one rate table in `models.json` applied to every arm,
never from a harness's own accounting. Failures, timeouts and harness errors stay in the sample as
incorrect runs; raw rows are kept in the results JSONL.

The gate for calling Steak DSH better than stock DSH is in `../GATE.md`; `summarize.py` prints its
three conditions as PASS/FAIL lines with numbers.

## Arms and exact commands

Each run gets a fresh fixture copy (`gen_fixture.prepare`), a hard timeout that kills the whole
process group (default 600 s), and its final answer written to `ans.txt` and graded with
`python3 checks/check.py <task> ans.txt` inside the fixture. Arm order is balanced per (rep, task).
Each lane sends one throwaway warm-up request per arm so the cache-write charge for the starting
prompt does not decide the result.

- **dsh** — `<DSH_BIN> headless --patch <generated model patch> --json --permission-mode workspace-write
  --approval-policy never <prompt>`, with `DSH_HOME=<per-lane dir>`, `DSH_TELEMETRY_MODE=DISABLED`,
  cwd = fixture. `DSH_BIN` defaults to `dsh` on PATH.
  The model patch is generated from `models.json`: one `llm-pi-ai` providers row (an OpenAI-compatible
  gateway route) and one `agent-default-model` row. Usage is summed over `status`/`step_end` NDJSON
  events; a run counts as a harness failure unless exit code 0 and `final.reason.kind == "completed"`.
  `dsh --version` is recorded in every row. The per-lane `DSH_HOME` is reused; its `sessions/` is
  deleted after each run.
- **sdsh** — the same command plus `--patch $STEAK_DSH_PATCH` (default `../cordis.patch.yml`) after the
  model patch, plus optional env from `$STEAK_DSH_ENV` (a JSON object of strings). A missing patch file
  is a named error before anything runs.
- **variants** — `--variant NAME=PATH` adds an arm `NAME` = dsh plus that patch, for ablations.
- **sp** — the raw Pi binary (`PI_BIN`, default `pi` on PATH; use a Pi with no extensions injected)
  with `-p --mode json --no-session` plus the model args from `models.json`. `PI_CODING_AGENT_DIR` is a
  per-lane agent dir the runner builds: copies of `~/.pi/agent/auth.json` and `models.json`, and a
  `settings.json` of `{"quietStartup":true,"packages":["$STEAK_PI_PACKAGE"]}`, which is how the Steak Pi package is loaded. Usage is summed over the assistant
  messages of the final `agent_end` event.
- **cc** — `claude -p <model args from models.json> --no-session-persistence --setting-sources ""
  --disable-slash-commands --strict-mcp-config --no-chrome --permission-mode acceptEdits
  --allowedTools Bash,Read,Edit,Write,Glob,Grep --output-format json <prompt>`. Claude models only;
  `--model haiku --arms dsh` is refused with a named error.

Keys are read from `~/.pi/agent/auth.json` (entry `{type:"api_key", key}`) inside the runner and
passed only via the child environment for the dsh arms; they are never printed or stored. Work dirs
live in a private folder under `$TMPDIR/steak-dsh-bench` that is removed when the runner exits, also when it is stopped.

## Models

`models.json` maps a key to per-arm settings and one rate table:

| key | model | dsh route | rates |
|---|---|---|---|
| `qwen` | qwen4-max-preview | `qwencloud` gateway (QwenCloud compatible-mode) | all 0 — flat plan |
| `deepseek` | deepseek/deepseek-v4.1-flash-1017:exacto | `openrouter` gateway, effort high | per-token dollars |
| `haiku` | claude-haiku-5-5 | none (cc/sp only) | per-token dollars |

When all rates for a model are 0, `summarize.py` reports a **weighted token count** instead of dollars
(input 1, cacheRead 0.1, cacheWrite 1.25, output 4) and labels the column `weighted tokens`.

## Reproduce

The `sp` arm needs `STEAK_PI_PACKAGE` (the folder of the Steak Pi package) and a `pi` binary with no extensions
injected (`PI_BIN`). The dsh arms need `dsh` on PATH or `DSH_BIN`. Keys are read from the Pi auth store
(`$PI_CODING_AGENT_DIR/auth.json`, default `~/.pi/agent/auth.json`).

```sh
cd <this repo>
# smoke (2 arms, 3 tasks, 1 rep, 2 lanes per arm)
python3 bench/run.py --model qwen --arms dsh,sp --reps 1 --par 2 --tasks t2,t3,t1 \
    --out smoke.jsonl
python3 bench/summarize.py smoke.jsonl --md

# full comparison on a paid model (needs the openrouter key in ~/.pi/agent/auth.json)
python3 bench/run.py --model deepseek --arms dsh,sdsh,sp --reps 5 --par 4 --out results.jsonl
python3 bench/summarize.py results.jsonl --baseline dsh --md

# ablation: dsh plus one feature patch
python3 bench/run.py --model qwen --arms dsh,nofoo --variant nofoo=patches/nofoo.yml \
    --reps 3 --par 2 --out ablation.jsonl
```

Runs are resumable: rows already in `--out` (matched on arm, model, task, rep) are skipped; rows are
appended and flushed one at a time. A run that hits a rate limit (429 in stderr or events) waits
30 s then 90 s and retries up to 2 times on a fresh fixture; the count is recorded in `retries`.
`summarize.py` writes `summary.json` beside the results file.

Requirements on this machine: the dsh install at the `DSH_BIN` path, the raw Pi binary at `PI_BIN`,
`claude` on PATH for the cc arm, the Steak Pi release package, and `~/.pi/agent/auth.json` with the
key entries named in `models.json`. Until `tasks.json` / `checks/check.py` / `gen_fixture.py` exist in
`bench/`, the runner falls back to a copy of the `benchmarks/ab` benchmark shipped with Steak Pi.

## Limits

- The dsh arms reach non-DeepSeek models through hand-declared pi-ai gateway routes. Those routes
  resend the full tool list on every request and deliver later system text as user-role reminders,
  so cache behavior differs from a native route. This affects all dsh-family arms equally, but not sp/cc.
- Wall times are measured with several runs in parallel and are noisy; treat them as indicative.
- The qwen plan is flat-rate: dollar cost is 0 for every arm, so comparisons there use weighted tokens,
  which is a proxy, not a price.
- Claude Code can only run Claude models, so the `haiku` key compares cc vs sp on Claude's own model;
  it is not a same-model comparison against dsh.
- Tasks are small Python fixtures with scripted checkers; they measure harness overhead and reliability
  on short tasks, not large-repo skill.
- The bootstrap intervals resample (task, rep) pairs; with few reps they are wide. The gate in GATE.md
  is evaluated on the full task set only.
- sp's `reasoning` token count is 0 when Pi's usage does not report it; cc rows have `reasoning`/`tools`
  as null because the Claude JSON result does not break them out.
