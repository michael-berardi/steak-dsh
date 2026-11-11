#!/usr/bin/env python3
"""usage: python3 summarize.py results.jsonl [--model KEY] [--baseline dsh] [--md]

Per model and arm: correct/total, uncached input, cached input, output, cost from the ONE rate table
in models.json (never a harness's own accounting), cost per correct run, median seconds, median turns.
Each arm vs the baseline, paired on (task, rep) present in both: ratios for cost, total input, output
and wall time with 95% bootstrap intervals (5000 resamples, seed 1), plus per-pair cost wins.
When all rates for a model are 0 (flat plan), a weighted token count is used instead of dollars
(input 1, cacheRead 0.1, cacheWrite 1.25, output 4) and the column is labelled `weighted tokens`.
Prints the three GATE.md conditions for sdsh vs dsh as PASS/FAIL lines. Writes summary.json beside
the results file. --md prints GitHub markdown tables.
"""
import argparse
import json
import os
import random
import statistics as S
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lib import common as C

BOOT_N = 5000
BOOT_SEED = 1


def ratio(n, d):
    if d > 0:
        return n / d
    if n == 0:
        return 1.0
    return float("inf")


def boot_ratio(pairs, f, g, rng):
    """ratio of sums f(arm)/g(baseline) over paired rows, with 95% bootstrap CI."""
    keys = list(pairs)
    if not keys:
        return None, None, None
    point = ratio(sum(f(pairs[k][0]) for k in keys), sum(g(pairs[k][1]) for k in keys))
    samples = []
    for _ in range(BOOT_N):
        ks = [rng.choice(keys) for _ in keys]
        samples.append(ratio(sum(f(pairs[k][0]) for k in ks), sum(g(pairs[k][1]) for k in ks)))
    samples.sort()
    return point, samples[int(0.025 * BOOT_N)], samples[int(0.975 * BOOT_N) - 1]


def gate(sdsh, dsh, pairs, rates, rng):
    """The three GATE.md conditions, with numbers. pairs: (task,rep) -> (sdsh_row, dsh_row)."""
    cs, cd = sum(r["ok"] for r in sdsh), sum(r["ok"] for r in dsh)
    g1 = cs >= cd

    def cpc_of(rows):
        ok = sum(r["ok"] for r in rows)
        m = sum(C.metric(r, rates) for r in rows)
        return m / ok if ok else (float("inf") if m else 0.0)

    def cpc_ratio(ps):
        a, b = cpc_of([p[0] for p in ps]), cpc_of([p[1] for p in ps])
        if b == float("inf"):
            return 0.0 if a != float("inf") else 1.0
        if b == 0:
            return float("inf") if a > 0 else 1.0
        return a / b

    ks = list(pairs)
    r2 = cpc_ratio([pairs[k] for k in ks]) if ks else float("nan")
    lo = hi = float("nan")
    if ks:
        samples = sorted(cpc_ratio([pairs[rng.choice(ks)] for _ in ks]) for _ in range(BOOT_N))
        lo, hi = samples[int(0.025 * BOOT_N)], samples[int(0.975 * BOOT_N) - 1]
    cond_a = r2 < 1.00 and hi < 1.00
    cond_b = (cs - cd >= 2) and r2 <= 1.05
    g2 = cond_a or cond_b

    bad = []
    tasks = sorted({r["task"] for r in sdsh} | {r["task"] for r in dsh})
    for t in tasks:
        s = [r for r in sdsh if r["task"] == t]
        d = [r for r in dsh if r["task"] == t]
        if s and d and not any(r["ok"] for r in s) and all(r["ok"] for r in d):
            bad.append(t)
    g3 = not bad
    return {
        "c1": {"pass": g1, "sdsh_correct": cs, "dsh_correct": cd},
        "c2": {"pass": g2, "cost_per_correct_ratio": r2, "ci95": [lo, hi],
               "correct_delta": cs - cd, "via": "ratio" if cond_a else ("correct+2" if cond_b else None)},
        "c3": {"pass": g3, "regressed_tasks": bad},
    }


def fmt(x, nd=2):
    if x is None:
        return "-"
    if x == float("inf"):
        return "inf"
    if x != x:
        return "n/a"
    return f"{x:.{nd}f}"


def clean(x):
    """JSON-safe: non-finite floats become strings, recursively."""
    if isinstance(x, float) and (x != x or x in (float("inf"), float("-inf"))):
        return "nan" if x != x else ("inf" if x > 0 else "-inf")
    if isinstance(x, dict):
        return {k: clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    return x


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("results")
    ap.add_argument("--model", help="only this model key")
    ap.add_argument("--baseline", default="dsh")
    ap.add_argument("--md", action="store_true", help="GitHub markdown tables")
    args = ap.parse_args()

    with open(args.results) as f:
        rows = [json.loads(l) for l in f if l.strip()]
    models = C.load_models()
    by_model = {}
    for r in rows:
        if args.model and r.get("model") != args.model:
            continue
        by_model.setdefault(r.get("model"), []).append(r)
    if not by_model:
        print("no rows", file=sys.stderr)
        sys.exit(1)

    rng = random.Random(BOOT_SEED)
    summary = {}
    out = []
    for model, rs in sorted(by_model.items()):
        if model not in models:
            print(f"error: unknown-model: rows carry model '{model}' which is not in models.json", file=sys.stderr)
            sys.exit(2)
        rates = models[model]["rates"]
        free = C.all_zero(rates)
        label = C.metric_label(rates)
        arms = sorted({r["arm"] for r in rs})
        per_arm = {}
        for a in arms:
            ar = [r for r in rs if r["arm"] == a]
            ok = sum(r["ok"] for r in ar)
            m = sum(C.metric(r, rates) for r in ar)
            per_arm[a] = {
                "correct": ok, "total": len(ar),
                "i": sum(r.get("i", 0) for r in ar), "cr": sum(r.get("cr", 0) for r in ar),
                "cw": sum(r.get("cw", 0) for r in ar), "o": sum(r.get("o", 0) for r in ar),
                "metric": m, "metric_per_correct": (m / ok if ok else None),
                "median_sec": S.median(r["sec"] for r in ar),
                "median_turns": S.median(r.get("turns") or 0 for r in ar),
            }
        # paired comparisons vs baseline
        pair_all = {}
        for r in rs:
            pair_all.setdefault((r["task"], r["rep"]), {})[r["arm"]] = r
        vs = {}
        base = args.baseline
        for a in arms:
            if a == base or base not in arms:
                continue
            pairs = {k: (v[a], v[base]) for k, v in pair_all.items() if a in v and base in v}
            if not pairs:
                continue
            entry = {"pairs": len(pairs)}
            for name, f in (("cost", lambda r: C.metric(r, rates)), ("total_input", C.total_input),
                            ("output", lambda r: r.get("o", 0)), ("wall_time", lambda r: r["sec"])):
                p, lo, hi = boot_ratio(pairs, f, f, rng)
                entry[name] = {"ratio": p, "ci95": [lo, hi]}
            entry["cost_wins"] = sum(C.metric(p[0], rates) < C.metric(p[1], rates) for p in pairs.values())
            vs[a] = entry
        # per-task correct counts
        tasks = sorted({r["task"] for r in rs})
        per_task = {t: {a: [sum(r["ok"] for r in rs if r["task"] == t and r["arm"] == a),
                          sum(1 for r in rs if r["task"] == t and r["arm"] == a)] for a in arms} for t in tasks}
        # GATE: sdsh vs dsh
        g = None
        if "sdsh" in arms and "dsh" in arms:
            gpairs = {k: (v["sdsh"], v["dsh"]) for k, v in pair_all.items() if "sdsh" in v and "dsh" in v}
            g = gate([r for r in rs if r["arm"] == "sdsh"], [r for r in rs if r["arm"] == "dsh"], gpairs, rates, rng)
        summary[model] = {"rates": rates, "metric": label, "note": models[model].get("note", ""),
                          "baseline": base, "arms": per_arm, "vs_baseline": vs,
                          "per_task": per_task, "gate": g}

        # ---- text output ----
        out.append(f"model {model}" + (f" ({models[model]['note']})" if models[model].get("note") else ""))
        if free:
            out.append("all rates are 0 (flat plan): using weighted tokens instead of dollars "
                       "(input 1, cacheRead 0.1, cacheWrite 1.25, output 4)")
        if args.md:
            out.append("")
            out.append(f"| arm | correct | uncached input | cached input (read/write) | output | {label} | "
                       f"{label}/correct | median s | median turns |")
            out.append("|---|---|---|---|---|---|---|---|---|")
            for a in arms:
                s = per_arm[a]
                out.append(f"| {a} | {s['correct']}/{s['total']} | {s['i']:,} | {s['cr']:,}/{s['cw']:,} | "
                           f"{s['o']:,} | {fmt(s['metric'], 4)} | {fmt(s['metric_per_correct'], 4)} | "
                           f"{fmt(s['median_sec'], 1)} | {fmt(s['median_turns'], 1)} |")
        else:
            for a in arms:
                s = per_arm[a]
                out.append(f"  {a:10} correct {s['correct']}/{s['total']}  uncached in {s['i']:,}  "
                           f"cache r/w {s['cr']:,}/{s['cw']:,}  out {s['o']:,}  {label} {fmt(s['metric'], 4)}  "
                           f"per correct {fmt(s['metric_per_correct'], 4)}  median {fmt(s['median_sec'], 1)}s  "
                           f"median turns {fmt(s['median_turns'], 1)}")
        for a, e in vs.items():
            if args.md:
                out.append("")
                out.append(f"{a} / {base}, paired on {e['pairs']} (task, rep) pairs; "
                           f"{a} cheaper in {e['cost_wins']}/{e['pairs']} pairs")
                out.append("")
                out.append(f"| measure | {a}/{base} | 95% CI |")
                out.append("|---|---|---|")
                for name in ("cost", "total_input", "output", "wall_time"):
                    r = e[name]
                    nm = label if name == "cost" else name
                    out.append(f"| {nm} | {fmt(r['ratio'])} | {fmt(r['ci95'][0])}-{fmt(r['ci95'][1])} |")
            else:
                out.append(f"  {a} vs {base} ({e['pairs']} pairs, cheaper in {e['cost_wins']}):")
                for name in ("cost", "total_input", "output", "wall_time"):
                    r = e[name]
                    nm = label if name == "cost" else name
                    out.append(f"    {nm:15} {fmt(r['ratio'])}  (95% CI {fmt(r['ci95'][0])}-{fmt(r['ci95'][1])})")
        if args.md:
            out.append("")
            out.append("| task | " + " | ".join(arms) + " |")
            out.append("|---|" + "---|" * len(arms))
            for t in tasks:
                out.append("| " + t + " | " + " | ".join(f"{per_task[t][a][0]}/{per_task[t][a][1]}" for a in arms) + " |")
        else:
            out.append("  per-task correct: " + "; ".join(
                t + " " + " ".join(f"{a}={per_task[t][a][0]}/{per_task[t][a][1]}" for a in arms) for t in tasks))
        if g:
            c1, c2, c3 = g["c1"], g["c2"], g["c3"]
            out.append(f"  GATE 1 correct sdsh >= dsh: {'PASS' if c1['pass'] else 'FAIL'} "
                       f"(sdsh {c1['sdsh_correct']}, dsh {c1['dsh_correct']})")
            out.append(f"  GATE 2 {label}/correct ratio <1.00 with CI <1.00, or +2 correct and ratio <=1.05: "
                       f"{'PASS' if c2['pass'] else 'FAIL'} (ratio {fmt(c2['cost_per_correct_ratio'])}, "
                       f"CI {fmt(c2['ci95'][0])}-{fmt(c2['ci95'][1])}, correct delta {c2['correct_delta']:+d})")
            out.append(f"  GATE 3 no task all-fail sdsh vs all-pass dsh: {'PASS' if c3['pass'] else 'FAIL'} "
                       f"({len(c3['regressed_tasks'])} tasks" +
                       (f": {', '.join(c3['regressed_tasks'])}" if c3['regressed_tasks'] else "") + ")")
        else:
            out.append("  GATE: not evaluated (needs both sdsh and dsh rows for this model)")
        out.append("")

    print("\n".join(out))
    dest = os.path.join(os.path.dirname(os.path.abspath(args.results)), "summary.json")
    with open(dest, "w") as f:
        json.dump(clean(summary), f, indent=2)
    print(f"wrote {dest}")


if __name__ == "__main__":
    main()
