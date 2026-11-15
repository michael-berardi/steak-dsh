# Profiles

## What it changes

| Part | What it does | Default |
|---|---|---|
| Full access | Long coding sessions can finish while you are away: commands run with full access and no approval prompts by default. | on |
| Lean tool set | Removes the tools a one-shot coding task does not use (goals, workflows, subagents, working-directory switch): 13 tools plus `more_tools` instead of 23 sent with every request. Skips the model-written session title. | on |
| Working rules | Six lines in the system prompt: batch independent tool calls, gather context once, compute on large files instead of reading them, check a change once, finish every part, keep the reply short. | on |
| Verify after edit | After a file edit, runs your project's check command and hands a failure straight back to the model with the edit result. After two failures in a row it pauses until your next request. | on, does nothing until you set a command |
| Owned paths | Refuses file edits outside the paths a task owns. Symlinks are resolved first. | per run, `--owned-path` |
| Finish guard | A turn cannot end while the todo list has open items or the reply reports unfinished work: the agent is told to keep going, at most 3 times per message, and the terminal UI shows a one-line notice each time. It reads the harness's own `todo_write` list, works the same in `run`, `chat` and `tui`, stands down for a question or an explicit hold, and leaves subagent children alone. Off with `STEAK_DSH_FINISH_GUARD=0` | on |
| Approval-never refusal | With approval policy `never`, a call that asks for a wider sandbox is refused before it runs, and the reason names the preset that would allow it. The harness alone would answer "the user rejected" though nobody was asked. Every other call passes through. | on, acts only under `never` |
| `more_tools` | One short tool (about 250 bytes on the first request). When the model calls it, the subagent tool, its follow-up tool and the working-directory switch are switched on and are in the next request, and the spill budget is raised so an oversized tool result stays readable by path. Goal and workflow tools stay off. | on |

Every row can be switched from your own profile patch:

```yaml
- id: steak-rules
  disabled: true
- id: steak-finish-guard
  disabled: true           # the guard is on by default
- id: tool-subagent        # give the subagent tool back before the first request
  disabled: false
```

### Long work

There is one profile. A one-shot task pays for 13 tools and the small `more_tools` tool; a long, multi-step or
delegating task calls `more_tools` once and gets the subagent tool, its follow-up tool and the working-directory
switch from the next request on. Nothing needs to be chosen up front:

```sh
steak-dsh run --verify "npm test" "migrate the store package to the new client, then update the callers"
```

How it works: the model's route decides whether a tool can be declared late, and an OpenAI-compatible route drops
tools marked as deferred, so the bundle does not use that. `more_tools` switches the bundle's own loader rows on at
runtime instead. The switch lasts for the dsh process: a resumed session offers `more_tools` again.

`--long` is still accepted and no longer needed. It is a preload: it applies one more shipped patch,
[`long.patch.yml`](../long.patch.yml), right after the bundle, so the same rows are on before the first request (18 tools,
about 3,600 bytes more on every request). Use it only when you know the task delegates from the start. Refused with `--stock`.
The rows it switches on:

```yaml
- id: tool-subagent            # delegate a bounded part to a child
  disabled: false
- id: tool-subagent-control    # follow up on a running child
  disabled: false
- id: tool-working-directory
  disabled: false
- id: spill-policy             # an oversized tool result keeps its head and tail inline and a path to the rest
  config:
    maxInlineTokens: 12500
```

Without the launcher it is one more `--patch`: `dsh headless --patch cordis.patch.yml --patch long.patch.yml "<task>"`.
Put the same rows in your profile patch to make them permanent.
