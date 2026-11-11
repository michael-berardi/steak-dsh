#!/usr/bin/env python3
"""Selftest for the benchmark tasks.

For every task t1..t8 and h1..h12:
  * the hidden check must FAIL on an untouched fixture,
  * the check must PASS after running bench/reference/<task>.py on a fresh fixture.
For the category-(b) tasks h3 and h4 the check must also FAIL after the obvious
wrong fix (bench/reference/<task>_wrong.py).
Prints one PASS line per task (20) and exits non-zero on any failure.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gen_fixture

CHECK = os.path.join(HERE, "checks", "check.py")
TASKS = json.load(open(os.path.join(HERE, "tasks.json")))
WRONG_FIX = {"h3", "h4"}
EXPECTED = [f"t{i}" for i in range(1, 9)] + [f"h{i}" for i in range(1, 13)]


def check(dest, task):
    r = subprocess.run([sys.executable, CHECK, task, "ans.txt"],
                       cwd=dest, capture_output=True, text=True)
    return r.stdout.strip() == "true", r.stderr.strip()


def run_script(dest, name):
    path = os.path.join(HERE, "reference", name + ".py")
    r = subprocess.run([sys.executable, path], cwd=dest, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"reference {name} failed: {r.stderr.strip()[-300:]}")


def fresh():
    d = tempfile.mkdtemp(prefix="bench-selftest-")
    gen_fixture.prepare(d)
    open(os.path.join(d, "ans.txt"), "w").write("")
    return d


def main():
    failures = 0
    if list(TASKS) != EXPECTED:
        print(f"FAIL tasks.json: expected {EXPECTED}, got {list(TASKS)}")
        return 1
    t0 = time.time()
    for task in TASKS:
        problems = []
        d = fresh()
        try:
            ok, why = check(d, task)
            if ok:
                problems.append("check passes on untouched fixture")
            try:
                run_script(d, task)
                ok, why = check(d, task)
                if not ok:
                    problems.append(f"check fails after reference: {why}")
            except RuntimeError as e:
                problems.append(str(e))
        finally:
            shutil.rmtree(d, ignore_errors=True)
        if task in WRONG_FIX:
            d = fresh()
            try:
                run_script(d, task + "_wrong")
                ok, _ = check(d, task)
                if ok:
                    problems.append("check passes after the obvious wrong fix")
            except RuntimeError as e:
                problems.append(str(e))
            finally:
                shutil.rmtree(d, ignore_errors=True)
        if problems:
            failures += 1
            print(f"FAIL {task}: " + "; ".join(problems))
        else:
            print(f"PASS {task}")
    print(f"selftest: {len(TASKS) - failures}/{len(TASKS)} passed in {time.time() - t0:.1f}s",
          file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
