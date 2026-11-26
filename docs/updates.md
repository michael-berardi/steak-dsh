<!-- update-contract: v1 -->

# Updates

Steak DSH tells you when a newer stable release exists and updates in one command. Automatic installation is opt-in and off by default.

## When it checks

- Only `chat` and `tui` on a terminal check, in the background a moment after launch; the launch never waits for it. `run` (headless, including `--json`), piped output, CI (`CI`) and agent hosts (`CLAUDECODE`, `CODEX_SANDBOX`, `GEMINI_CLI`) never check.
- At most once every 24 hours: one anonymous GET of this project's public GitHub `releases/latest` record with the User-Agent `steak-dsh-update-check`. No version, identifier, usage or machine data is sent. A 4-second timeout, no retries; a failure is recorded with its cause and printed only by `steak-dsh update --check`.
- Only stable `x.y.z` releases newer than yours count. Drafts, prereleases and unparseable tags are ignored.
- Turn checks off with `STEAK_DSH_NO_UPDATE_CHECK=1`, or with `"updates": { "checkAutomatically": false }` in `$DSH_HOME/steak-dsh.json`.

## The notice

After the session, on stderr, at most once a day per version:

```
steak-dsh 0.19.0 available (you have 0.18.0) · run: steak-dsh update
turn on automatic updates: steak-dsh update --auto on · skip: steak-dsh update --skip
```

## Commands

| Command | What it does |
|---|---|
| `steak-dsh update` | Shows current → new and the first release-note lines. On a terminal it asks `Install 0.19.0 now? [Y/n]`, and after the install asks once `Install future updates automatically? [y/N]`. Without a terminal it installs without asking. |
| `steak-dsh update --check` | Report only. Exit 0 up to date, 10 update available, 1 check failed (the cause is printed). |
| `steak-dsh update --skip` | No notice for this version; a newer release notifies again. |
| `steak-dsh update --auto on\|off\|status` | Automatic installs, saved in `$DSH_HOME/steak-dsh.json`. `status` also shows whether checks are on and the current version. |
| `steak-dsh update --rollback` | Back to the previous release (installer copies only). |

## How it installs

- **Installer copies** (`~/.steak-dsh/app/release-<version>`, on Windows under `%LOCALAPPDATA%\steak-dsh`): the new release's `install.sh` (`install.ps1` on Windows) and `SHA256SUMS` are downloaded into a temporary folder. The installer runs only if its SHA-256 matches, pinned to that version. It checks the archive's SHA-256 before unpacking, checks that the new copy starts, and then swaps the `current` link. The temporary folder is deleted after both success and failure.
- **npm global copies** are upgraded with `npm i -g github:<owner>/<repo>#v<version>`, because npm owns those files.
- **Source checkouts** are never changed: `update` prints `git -C <checkout> pull`.
- A running session is never touched. The new version applies on the next launch.
- With automatic updates on, the session that finds a release starts the same install when it ends, as a detached, low-priority process. Its log is `$DSH_HOME/steak-dsh/logs/update.log`: one file, only the last install, at most 256 KB. If the install fails, the cause is kept, and the next session shows the notice with that cause.

## Rollback

The installer keeps the release that was current before the update as the only rollback copy. That copy is removed after the new release has finished one `run`, `chat` or `tui` session successfully, or after 7 days at most. `steak-dsh update --rollback` checks that the old release starts, points `current` back at it, and skips the version you rolled back from.

## Files

- `$XDG_CACHE_HOME/steak-dsh/update.json` (default `~/.cache/steak-dsh/update.json`), mode 0600, written atomically: time of the last check, latest version and its first note lines, last error, skipped version, last notice, and automatic-install state.
- `"updates"` in `$DSH_HOME/steak-dsh.json`: `checkAutomatically`, `auto`, `autoAsked`. Other settings in that file are kept. A file that is not valid JSON is never overwritten.
- `$DSH_HOME/steak-dsh/logs/update.log` exists only with automatic updates; `steak-dsh update --auto off` deletes it.

To leave nothing behind, run `steak-dsh update --auto off`, uninstall as the README describes, then delete `~/.cache/steak-dsh`.

## Testing

`STEAK_DSH_UPDATE_API` points the check at another release record, and `STEAK_DSH_RELEASE_BASE` points the installer at another asset folder. The test suite uses both with local servers; normal use needs neither.
