## The terminal UI

By default, the agent runs commands with full access to your machine and never stops to ask, so long coding sessions can finish while you are away. The agent can run any command you could. To confine it, use `--permission workspace-write` (writes stay inside the working folder and temp folders) or `--permission read-only`, and add `--approval-policy ask` in the TUI to be asked before each wider action.

`steak-dsh tui` is a full-screen terminal UI that follows the layout and vocabulary of the Steak Pi companion: a one-line
header, the transcript, a status band, and a multi-line editor. It takes the same options as `chat` (`--model`,
`--long`, `--stock`, `--effort`, `--owned-path`, `--verify`, `--patch`, ...) and needs `--model`, because the SDK wire
has to be told which model to run. It starts one long-lived `dsh --profile sdk` child with the same overlay files
`run` and `chat` use, and talks to it over JSON-RPC on stdio. No dependency, no model built in.

```sh
steak-dsh tui --model acme/coder-large
steak-dsh tui --model acme/coder-large --long --owned-path "$PWD/src"
```

An empty session shows only the header, the status band and the editor (frame from the test renderer, 80 columns,
middle rows cut). From 12 rows up there is one blank row above the header and one below it:

```text

🥩  STEAK DSH                               / commands · /new · /compact · /exit

◆ example-model-1 · high · ● new session ───────────────────────────── ◫ ?/131k
╰─ Message
```

A frame from a scripted session (the test suite feeds recorded event sequences through the same renderer; no model
was called), 80 columns, 38 rows. Tool cards, a numbered diff, a failed tool, Markdown, and the status band with
context meter, tokens and cache share:

```text
🥩  STEAK DSH                               / commands · /new · /compact · /exit
 I'll read the pane first.

 ✓ read src/pane.js
 1: line 1 of the file
 2: line 2 of the file
 3: line 3 of the file
 4: line 4 of the file
 5: line 5 of the file
 6: line 6 of the file
 7: line 7 of the file
 8: line 8 of the file
 9: line 9 of the file
 10: line 10 of the file
 ... (4 more lines, ctrl+o to expand)
 ✓ edit src/pane.js
 src/pane.js
  40 function layout(w) {
 -41   const gap = 1;
 +41   const gap = 2;
 +42   const pad = 1;
  43   return w - gap;
  44 }
 ! bash npm test -- --grep pane
 EXIT_NONZERO: 1 test failed: pane layout keeps the gap

 Result

 The gap is now 2 columns and layout() keeps a one column pad.

 • the pane test still fails on the gap
 • run npm test after adjusting the fixture

 ╭ js
 │ const gap = 2;
◆ example-model-1 · high · ✓ complete ━───── ◫ 10%/131k · 23.6k tok · 78% cache
╰─ Message
```

The band reads `◆ model · effort · state`, then a context meter and `◫ percent/window · tokens · cache share · cost`.
An atom with no data is left out rather than guessed. The cost is what the route reports for each request when it
does (the `claude-code` route passes on the figure the CLI states); otherwise it is the session's tokens times the
model's price in the harness's own model catalog, with cache reads and writes at their own rates. On a login billed
to a plan this is the list price of the work, not a charge. A route with no known price, such as a gateway declared
with `--base-url`, shows no cost. States: `● ready`, `◆ thinking`, `◆ responding`, `◆ tool <name>`, `◇ waiting · <what>`, `◆ compacting`,
`✓ complete`, `! error · <why>`, `! stopped · <why>`.

Keys: Enter sends; Ctrl-J, Alt-Enter or a trailing `\` then Enter adds a line; Up/Down browse history at the edges;
Ctrl-A/E/B/F, Alt-B/F, Ctrl-W, Ctrl-U, Ctrl-K, Ctrl-Y edit; holding Backspace for 1.5 s clears the input;
PageUp/PageDown scroll; Ctrl-O expands tool output; Ctrl-T shows or hides thinking; Esc interrupts the turn; Ctrl-C
interrupts, then clears the editor, then quits; Ctrl-D quits on an empty editor. Pasted text (bracketed paste) is
inserted as typed text and never sent or interpreted. `/new`, `/resume <id>` and `/exit` are local; any other
`/command` goes to the harness (for example `/compact`, `/permission <preset>`).

`--permission` is applied with
`/permission <preset>` before the first prompt of every session and again after every restart and `/resume`. A
preset you type yourself (`/permission danger-full-access`) is kept across restarts and `/new`. A new session gets
the preset and policy when the harness creates it, because the overlay makes them its defaults.

With `--approval-policy ask`, an approval opens a selector above the band: `Allow once`, `Allow for this session`,
`Reject` (keys `y`, `a`, `n`/Esc). The harness's approval reply only has a one-time grant, so `Allow for this
session` is kept by the terminal UI: until you quit, it answers the same request itself (same session, tool and
sandbox mode, whatever the justification says) and adds a line saying so. While a prompt is open the band shows
`◇ waiting · <tool> · since HH:MM`. If the harness dies, every open approval and question is dropped and nothing is
allowed. An answer given after that never reaches the restarted harness. Esc cancels a turn by stopping the child,
starting a new one and resuming the same session (the SDK wire has no cancel call), which takes a few seconds.

If the harness exits on its own, the notice gives the exit code, the first error line of its stderr and the top stack
frame. The whole stderr goes to a private file, `$DSH_HOME/steak-dsh/logs/harness-exit-<time>-<pid>-<n>.log` (`0600`
in a `0700` folder), and the notice names it. The next message restarts the harness and resumes the session. If the
same failure happens twice in a row on the same session with no finished turn in between, the terminal UI stops
restarting. It says so with the cause, keeps the session id on screen, and offers `/new`; `/resume <id>` tries the
old session again. Before every restart the generated overlay file is written again if a temp cleaner removed it.
Before 0.9.0 a missing overlay killed every restart at boot, and the notice showed only Node's version line.

What it cannot match: text arrives per committed step, not token by token (the SDK wire carries committed messages
only); the editor is keyboard-only (no IME placement, mouse or autocomplete); Markdown is minimal and code is not
syntax-highlighted; a declared gateway route shows no cost; `--add-dir` has no effect over the SDK wire; the model is fixed for the
process. `NO_COLOR`, a dumb terminal, or a pipe turns colour off; on a pipe `tui` runs in plain line mode (each stdin
line is a message, approvals are refused).

