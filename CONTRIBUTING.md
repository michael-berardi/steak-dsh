# Contributing

Issues and focused pull requests are welcome.

```sh
git clone https://github.com/michael-berardi/steak-dsh.git
cd steak-dsh
npm test                      # Node 22 or newer, no dependencies to install
python3 bench/selftest.py     # every benchmark task: check fails untouched, passes on the reference solution
```

- Plugins import only Node built-ins, so they load from any `dsh` profile. A test enforces it.
- Shipped code names no model, provider or person. Model choices belong in flags and in `bench/models.json`.
- A feature stays in the default bundle only when the benchmark shows it helps. Add its ablation with
  `bench/run.py --variant NAME=PATCH` and include the numbers in the pull request.
- Do not commit credentials, session data or raw benchmark traces. This project runs its checks locally and does
  not accept GitHub Actions workflows.
