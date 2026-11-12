# Steak DSH

Steak DSH is a plugin bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). It makes
one-shot coding tasks cost less on the same model, and adds a check after every edit, owned paths for file edits, and
a launcher that picks the model with flags.

Cost against stock DSH 0.2.2-rc.1 on the same model, every run correct in both:

| Model and run | Steak DSH / stock DSH | 95% interval | Steak DSH cheaper in |
|---|---|---|---|
| DeepSeek V4.1 Flash, first run (the one the gate was written for) | 0.84 | 0.76 to 0.93 | 73 of 100 pairs |
| DeepSeek V4.1 Flash, second run | 0.92 | 0.81 to 1.06 | 35 of 60 pairs |
| Qwen 4 Max (weighted tokens) | 0.70 | 0.62 to 0.78 | 78 of 100 pairs |

The second DeepSeek run does not show a clear saving on its own. Both runs together give 0.87 (0.80 to 0.94) over
160 pairs; that pooling was decided after seeing the second run.

MIT. No dependencies. By [Pareto Cybernetics](https://paretocybernetics.com).

## Install

One step, the whole bundle. macOS and Linux:

```sh
curl -fsSL https://github.com/michael-berardi/steak-dsh/releases/latest/download/install.sh | sh
```

Windows (PowerShell 5.1 or 7):

```powershell
irm https://github.com/michael-berardi/steak-dsh/releases/latest/download/install.ps1 | iex
```

The installer checks the release SHA-256, then does everything needed to leave `steak-dsh` working:

- **dsh already installed** (a working `dsh` 0.2.2-rc.1 or newer on PATH): it uses yours, adds Steak DSH to it, and
  prints `dsh was already installed: added Steak DSH to it`. Your dsh is never modified or shadowed.
- **No dsh**: it installs DeepSeek Harness (`@deepseek-ai/dsh` 0.2.2-rc.1, about 650 npm packages, a few minutes)
  into `~/.steak-dsh/dsh`, puts a `dsh` command next to `steak-dsh`, and prints
  `installed DeepSeek Harness and Steak DSH`. Pin another dsh version with `STEAK_DSH_DSH_VERSION`.
- **Node**: uses a system Node 22 or newer; when missing, fetches the official Node 22 build (checksum verified)
  into `~/.steak-dsh/node`. Nothing is installed globally.
- Adds the bundle to your dsh `headless` profile with `dsh plugin --profile headless add`. That step needs pnpm;
  the installer brings it privately when missing. If the profile step fails it says so and continues: the
  `steak-dsh` launcher works without it.
- Finishes by running `steak-dsh doctor` and showing the result.

Everything lives under `~/.steak-dsh` (Windows: `%LOCALAPPDATA%\steak-dsh`). The commands go to `~/.local/bin`
(Windows: `%LOCALAPPDATA%\steak-dsh\bin`, added to your user PATH). No sudo, no shell profile edits; when
`~/.local/bin` is not on your PATH the installer prints the one line to add. Overrides: `STEAK_DSH_HOME`,
`STEAK_DSH_BIN_DIR`, `STEAK_DSH_VERSION` (pin a release), `STEAK_DSH_DSH_VERSION`, `STEAK_DSH_RELEASE_BASE`.

**Update**: run the same one-liner again; it upgrades in place. **Remove**: delete `~/.steak-dsh` and the
`steak-dsh` shim in `~/.local/bin` (plus the `dsh` shim there, if the installer created it), and
`dsh plugin --profile headless remove steak-dsh` if you want it out of the profile.

### Manual route

You need `dsh` 0.2.2-rc.1 or newer (`npm i -g @deepseek-ai/dsh`) and Node 22 or newer.

**As a plugin**, in the profile you already use:

```sh
dsh plugin --profile headless add github:michael-berardi/steak-dsh#v0.1.2
```

`dsh` adds the bundle to that profile's bundle list. Every `dsh headless "task"` now runs with it. Remove it with
`dsh plugin --profile headless remove steak-dsh`.

**As a launcher**, which changes none of your profiles:

```sh
npm i -g github:michael-berardi/steak-dsh#v0.1.2
steak-dsh doctor
steak-dsh run "fix the failing test in src/parser"
```

## What it changes

| Part | What it does | Default |
|---|---|---|
| Lean tool set | Removes the tools a one-shot coding task does not use (goals, workflows, subagents, working-directory switch): 13 tools instead of 23 sent with every request. Skips the model-written session title. | on |
| Working rules | Six lines in the system prompt: batch independent tool calls, gather context once, compute on large files instead of reading them, check a change once, finish every part, keep the reply short. | on |
| Verify after edit | After a file edit, runs your project's check command and hands a failure straight back to the model with the edit result. After two failures in a row it pauses until your next request. | on, does nothing until you set a command |
| Owned paths | Refuses file edits outside the paths a task owns. Symlinks are resolved first. | per run, `--owned-path` |
| Finish guard | Keeps the turn open when the todo list has open items or the reply reports unfinished work. Leaves subagent children alone. | off, on with `--long` |
| Long-work profile | For multi-step or delegating work: gives back the subagent tool, its follow-up tool and the working-directory switch, turns the finish guard on, and states the spill budget so an oversized tool result stays readable by path. 18 tools instead of 13. Goal and workflow tools stay off. | off, `--long` |

Every row can be switched from your own profile patch:

```yaml
- id: steak-rules
  disabled: true
- id: steak-finish-guard
  disabled: false
- id: tool-subagent        # give the subagent tool back
  disabled: false
```

### Long work

The default is tuned for one-shot tasks, where a tool that is never called is only schema text on every request.
Long, multi-step or delegating work is the opposite case, so it has its own switch:

```sh
steak-dsh run --long --verify "npm test" "migrate the store package to the new client, then update the callers"
```

`--long` adds five rows after the bundle and changes nothing when it is absent:

```yaml
- id: tool-subagent            # delegate a bounded part to a child
  disabled: false
- id: tool-subagent-control    # follow up on a running child
  disabled: false
- id: tool-working-directory
  disabled: false
- id: steak-finish-guard
  disabled: false
- id: spill-policy             # an oversized tool result keeps its head and tail inline and a path to the rest
  config:
    maxInlineTokens: 12500
```

Put the same rows in your profile patch to make them permanent. Measured on dsh 0.2.2-rc.1 against a local scripted
endpoint (no model call): the first request carries 23 tools and 22,890 bytes on stock dsh, 13 tools and 12,532 bytes
with the bundle, and 18 tools and 16,167 bytes with `--long`. That is the price of the profile per request. Whether
it pays back on your long tasks is a separate measurement: see the gate in [GATE.md](GATE.md) and compare the two
profiles on the same tasks before making it your default.

### Verify after edit

Set the command per run:

```sh
steak-dsh run --verify "npm test" "rename parseDate to parseIsoDate everywhere"
```

Or once per project, in `$DSH_HOME/steak-dsh.json` (default `~/.dsh/steak-dsh.json`):

```json
{ "projects": { "/abs/path/to/project": { "verify": { "command": "npm test", "failLimit": 2, "timeoutMs": 90000 } } } }
```

A project can carry its own `.steak-dsh/config.json` with the same `verify` block. It is read only when you list that
project under `"trusted"` in `$DSH_HOME/steak-dsh.json`.

## The launcher

Stock `dsh` has no model flags. `steak-dsh` adds them and passes everything else through.

```sh
# a provider your dsh already knows
steak-dsh run --model deepseek-official/deepseek-flash "add a --json flag to the report command"

# any OpenAI- or Anthropic-compatible endpoint, declared for this run only
export GATEWAY_KEY=...
steak-dsh run --model acme/coder-large --base-url https://gateway.example/v1 --api openai-completions \
  --key-env GATEWAY_KEY --effort high "fix the flaky retry test"

steak-dsh chat --model deepseek-official/deepseek-flash      # line-based terminal chat
steak-dsh run --stock "same task on stock dsh"                # A/B against the unmodified harness
steak-dsh run --long "a multi-step task"                      # long-work profile: delegation tools and the finish guard on
steak-dsh run --json --owned-path "$PWD/src" --no-shell "..." # scripted use: NDJSON events, edits fenced to src/
```

`steak-dsh --help` lists every flag. `--key-env` takes the name of an environment variable, never the key.

## Benchmark

Twenty small Python tasks with scripted checkers the agent never sees: multi-file bugs, a fix whose obvious version
breaks another requirement, exact answers from 2 to 4 MB files, five-part requests, a rename with one string that must
stay, edits in a 340-line file checked by hash. Same model, same effort, same prompt, fresh fixture per run, five
repeats, each harness on its stock configuration. Cost uses one price table for every harness. Measured 2026-11-11.
The gate was written before the first run ([GATE.md](GATE.md)).

**DeepSeek V4.1 Flash**, 300 runs

| Harness | Correct | Cost per run | Median time | vs stock DSH (95% interval) |
|---|---|---|---|---|
| Stock DSH 0.2.2-rc.1 | 100/100 | $0.00106 | 18.9 s | 1.00 |
| **Steak DSH 0.1.0** | 100/100 | **$0.00089** | **17.5 s** | **0.84** (0.76 to 0.93) |
| Steak Pi 0.25.7 | 100/100 | $0.00121 | 18.2 s | 1.14 (0.99 to 1.29) |

Steak DSH against Steak Pi on this model: cost 0.74 (0.65 to 0.84), total time 0.82 (0.73 to 0.92). The time ratio
compares total seconds over all runs; the table shows medians, which are closer.

**Qwen 4 Max**, 300 runs. The plan is flat-rate, so cost is weighted tokens (input 1, cached input 0.1, output 4).

| Harness | Correct | Weighted tokens per run | Median time | vs stock DSH (95% interval) |
|---|---|---|---|---|
| Stock DSH 0.2.2-rc.1 | 100/100 | 19,248 | 48.1 s | 1.00 |
| **Steak DSH 0.1.0** | 100/100 | 13,395 | 42.1 s | **0.70** (0.62 to 0.78) |
| Steak Pi 0.25.7 | 100/100 | **12,807** | **30.9 s** | 0.67 (0.60 to 0.74) |

Steak DSH against Steak Pi on this model: weighted tokens 1.05 (0.96 to 1.15), total time 1.26 (1.12 to 1.42). Steak
Pi is faster here.

**Claude Haiku 5.5**, 80 runs. DSH has no route to Claude models, so this table compares Steak Pi and Claude Code.

| Harness | Correct | Cost per run | Median time | vs Claude Code (95% interval) |
|---|---|---|---|---|
| Claude Code | 40/40 | $0.00276 | 10.4 s | 1.00 |
| Steak Pi 0.25.7 | 39/40 | $0.00216 | 15.3 s | 0.78 (0.60 to 1.04) |

**Second run, with stock Pi added** ([ParetoBench](https://github.com/michael-berardi/paretobench), DeepSeek V4.1
Flash, 240 runs, three repeats)

| Harness | Correct | Cost per run | Median time | vs stock Pi (95% interval) |
|---|---|---|---|---|
| **Pi 1.0.4 (stock)** | 60/60 | **$0.00060** | **14.8 s** | 1.00 |
| Steak DSH 0.1.0 | 60/60 | $0.00088 | 21.3 s | 1.47 (1.26 to 1.70) |
| Stock DSH 0.2.2-rc.1 | 60/60 | $0.00095 | 20.4 s | 1.59 (1.44 to 1.74) |
| Steak Pi 0.25.7 | 60/60 | $0.00122 | 22.5 s | 2.04 (1.71 to 2.37) |

In this run Steak DSH against stock DSH was 0.92 (0.81 to 1.06). Taken alone, that does not meet condition 2 of the
gate, because the interval reaches 1.00. Over both runs together, 160 pairs, it is 0.87 (0.80 to 0.94). The gate
named the first run as the verdict sample; pooling the two is an analysis chosen afterwards.

What the data says:

- Steak DSH costs less than stock DSH on Qwen 4 Max, with the whole interval below 1.00. On DeepSeek V4.1 Flash the
  gated run shows a saving (0.84) and the second run does not show a clear one (0.92, interval to 1.06). Expect about
  a tenth on that model, and treat it as likely, not settled.
- Stock Pi is the cheapest and fastest harness on these short tasks, ahead of every DSH variant and of Steak Pi. The
  tools Steak Pi adds are overhead on a 20-second task; they are built for long sessions, which this task set does not
  measure.
- Which of Steak DSH and Steak Pi is better depends on the model. On DeepSeek V4.1 Flash, Steak DSH is cheaper and
  faster. On Qwen 4 Max they cost the same and Steak Pi is faster.
- Every harness solved every task on the two open models, so these tasks measure cost and time. They do not show a
  difference in what the harnesses can solve.

Where the saving comes from (ablations, fewer pairs, so wide intervals): on DeepSeek V4.1 Flash the lean tool set
alone gave 0.93 (0.81 to 1.06) and lean tools plus the working rules 0.79 (0.67 to 0.95), 40 pairs each. On Qwen 4 Max
the lean tool set alone gave 0.80 (0.69 to 0.92) and the rules alone 0.86 (0.76 to 0.97), 20 pairs each. The lean tool
set ships on because of its effect on Qwen 4 Max; on DeepSeek V4.1 Flash it is not shown to help alone. The finish
guard was switched on for 40 Steak DSH runs and never acted, so it ships off. Ablation rows are not published.

The tables are for the bundle as released in 0.1.0. Later versions change the launcher and verify-after-edit, which
the benchmark does not exercise, and leave the measured bundle rows as they were.

Limits: 20 small tasks in one language on one machine. Runs were three at a time, so wall times are noisy. Two repeats
were planned; a first look gave 0.89 (0.78 to 1.02) on DeepSeek V4.1 Flash, so the sample was extended once to a fixed
five repeats, recorded in GATE.md before the extra runs. On a declared gateway route DSH cannot send the session
headers Steak Pi sends, which may affect cache hits for either side.

Raw rows are in [benchmarks/results](benchmarks/results); the second run's rows are in the ParetoBench repository
under `results/2026-11-11-harness-deepseek`. Reproduce:

```sh
python3 benchmarks/selftest.py
python3 benchmarks/run.py --model deepseek --arms dsh,sdsh,sp --reps 5 --par 3 --out results.jsonl
python3 benchmarks/summarize.py results.jsonl --md
```

`benchmarks/models.json` holds the routes and prices. The maintained version of this benchmark is
[ParetoBench](https://github.com/michael-berardi/paretobench).

## Security

Plugins run inside the `dsh` process. Owned paths gate the file-editing tools, not the shell: pair `--owned-path` with
`--no-shell` when the boundary matters. See [SECURITY.md](SECURITY.md).

## Development

```sh
npm test                    # 49 tests, Node built-ins only
python3 benchmarks/selftest.py   # 20 tasks: check fails untouched, passes on the reference solution
```
