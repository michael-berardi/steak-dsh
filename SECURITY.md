# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](https://github.com/michael-berardi/steak-dsh/security/advisories/new).
Do not open a public issue for an unpatched vulnerability, and do not include credentials or private
repository content in a report. Include the Steak DSH and `dsh` versions, reproduction steps and impact.

## Trust boundary

Steak DSH plugins run inside the `dsh` process with its permissions.

- **Owned paths** gate the file-editing tools (`edit`, `write`, `apply_patch`, `str_replace_editor`). They do not
  gate the shell: a task that may run shell commands can write anywhere the `dsh` permission preset allows. Pair
  `--owned-path` with `--no-shell` when the boundary matters.
- **Verify after edit** runs a shell command. The command is read only from places you control: the launcher flag,
  the bundle row config, or `$DSH_HOME/steak-dsh.json`. A `.steak-dsh/config.json` inside a project is ignored
  unless you listed that project under `trusted`, so cloning a repository cannot make the harness run its command.
- **Keys** are never passed on the command line. `--key-env` takes the name of an environment variable.
