#!/usr/bin/env python3
"""Multi-arm coding-agent benchmark runner (stock dsh, Steak DSH, ablation variants, Steak Pi, Claude Code).

usage: python3 run.py --model KEY --arms dsh,sdsh,sp,cc --reps N --par P --out results.jsonl
                      [--tasks t1,h3] [--timeout 600] [--variant NAME=PATCH ...]

Same model, same tasks, same checker, fresh fixture per run. One rate table lives in models.json
(cost is computed by summarize.py, never by a harness). Rows are appended one at a time and already
present (arm, model, task, rep) rows are skipped, so an interrupted run resumes. Failed runs are
recorded, never hidden. Keys are read from ~/.pi/agent/auth.json and passed only via the child env;
they are never printed or stored. Work dirs live under $TMPDIR/steak-dsh-bench, never in the repo.
"""
import argparse
import atexit
import importlib.util
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lib import common as C

WARM_PROMPT = "Reply with the single word ok."
BASE_ARMS = ("dsh", "sdsh", "sp", "cc")


def die(name, msg):
    print(f"error: {name}: {msg}", file=sys.stderr)
    sys.exit(2)


class RunFail(Exception):
    def __init__(self, msg, out="", err=""):
        super().__init__(msg)
        self.out, self.err = out, err


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True, help="key in models.json (qwen, deepseek, haiku)")
    ap.add_argument("--arms", default="dsh,sdsh,sp,cc")
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--par", type=int, default=2, help="parallel lanes per arm")
    ap.add_argument("--out", default="results.jsonl")
    ap.add_argument("--tasks", help="comma-separated task ids (default: all)")
    ap.add_argument("--timeout", type=int, default=600, help="hard per-run timeout, seconds")
    ap.add_argument("--variant", action="append", default=[], metavar="NAME=PATCH",
                    help="extra ablation arm: dsh plus this patch (repeatable)")
    args = ap.parse_args()

    models = C.load_models()
    if args.model not in models:
        die("unknown-model", f"'{args.model}' not in models.json (have: {', '.join(models)})")
    mcfg = models[args.model]

    arms = [a.strip() for a in args.arms.split(",") if a.strip()]
    variants = {}
    for v in args.variant:
        if "=" not in v:
            die("bad-variant", f"--variant expects NAME=PATCH, got '{v}'")
        name, path = v.split("=", 1)
        if name in BASE_ARMS or name in variants:
            die("bad-variant", f"variant name '{name}' collides with an existing arm")
        variants[name] = os.path.abspath(os.path.expanduser(path))
    for a in arms:
        if a not in BASE_ARMS and a not in variants:
            die("unknown-arm", f"'{a}' (base arms: {', '.join(BASE_ARMS)}; declare variants with --variant)")

    def kind(arm):
        return "dsh" if arm in ("dsh", "sdsh") or arm in variants else arm

    # --- validate everything before anything runs ---
    dsh_cfg = mcfg.get("dsh")
    for a in arms:
        if kind(a) == "dsh" and not dsh_cfg:
            die("dsh-unavailable-for-model",
                f"model '{args.model}' has no dsh route; arm '{a}' cannot run on it (Claude models run on cc/sp only)")
        if kind(a) == "sp" and not mcfg.get("sp"):
            die("sp-unavailable-for-model", f"model '{args.model}' has no sp args in models.json")
        if kind(a) == "cc" and not mcfg.get("cc"):
            die("cc-unavailable-for-model", f"model '{args.model}' has no cc args in models.json")

    sdsh_patch = os.path.abspath(os.path.expanduser(os.environ.get("STEAK_DSH_PATCH", C.SDSH_PATCH_DEFAULT)))
    if "sdsh" in arms and not os.path.isfile(sdsh_patch):
        die("steak-dsh-patch-missing", f"{sdsh_patch} (set STEAK_DSH_PATCH to the bundle patch)")
    for name, path in variants.items():
        if name in arms and not os.path.isfile(path):
            die("variant-patch-missing", f"variant '{name}': {path}")
    sdsh_env = {}
    if os.environ.get("STEAK_DSH_ENV"):
        try:
            sdsh_env = json.loads(os.environ["STEAK_DSH_ENV"])
            assert isinstance(sdsh_env, dict) and all(isinstance(v, str) for v in sdsh_env.values())
        except Exception:
            die("bad-steak-dsh-env", "STEAK_DSH_ENV must be a JSON object of string values")

    dsh_bin = os.path.expanduser(os.environ.get("DSH_BIN", C.DSH_BIN_DEFAULT))
    pi_bin = os.path.expanduser(os.environ.get("PI_BIN", C.PI_BIN_DEFAULT))
    kinds = {kind(a) for a in arms}
    if "dsh" in kinds and not os.path.isfile(dsh_bin):
        die("dsh-bin-missing", f"{dsh_bin or 'dsh is not on PATH'} (install @deepseek-ai/dsh or set DSH_BIN)")
    if "sp" in kinds and not os.path.isdir(C.STEAK_PI_PKG):
        die("steak-pi-package-missing", "set STEAK_PI_PACKAGE to the folder of the Steak Pi package for the sp arm")
    if "sp" in kinds and not os.path.isfile(pi_bin):
        die("pi-bin-missing", f"{pi_bin} (set PI_BIN)")
    if "cc" in kinds and not shutil.which("claude"):
        die("claude-bin-missing", "claude not on PATH")

    key_env, key_val = None, None
    if "dsh" in kinds:
        ks = mcfg.get("key") or {}
        if not ks.get("auth") or not ks.get("env"):
            die("key-config-missing", f"models.json '{args.model}' needs key.auth and key.env for dsh arms")
        try:
            with open(C.AUTH_PATH) as f:
                entry = json.load(f)[ks["auth"]]
            assert entry.get("type") == "api_key" and entry.get("key")
        except Exception:
            die("auth-entry-missing", f"no api_key entry '{ks['auth']}' in {C.AUTH_PATH}")
        key_env, key_val = ks["env"], entry["key"]

    def scrub(s):
        return s.replace(key_val, "***") if key_val else s

    # --- tasks, fixture, checker: prefer the bench worker's files, fall back to the ab benchmark copy ---
    # One private work dir per runner process: two runs started at the same time must never share fixtures,
    # harness homes or agent dirs. It is removed on exit, because the Steak Pi lanes hold a copy of the auth store.
    base = os.path.join(tempfile.gettempdir(), "steak-dsh-bench")
    os.makedirs(base, exist_ok=True)
    work = tempfile.mkdtemp(prefix=f"run-{os.getpid()}-", dir=base)
    os.chmod(work, 0o700)
    live = set()
    live_lock = threading.Lock()
    stopping = threading.Event()  # set first on a stop: no new child, no new fixture, no result row after it

    def cleanup():
        with live_lock:
            pids = list(live)
        for pid in pids:
            try:
                os.killpg(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        shutil.rmtree(work, ignore_errors=True)

    def on_signal(signum, _frame):
        stopping.set()
        print(f"stopped by signal {signum}: killing {len(live)} child process group(s)", file=sys.stderr, flush=True)
        cleanup()
        time.sleep(0.3)  # let worker threads observe the stop before the last sweep
        shutil.rmtree(work, ignore_errors=True)
        os._exit(128 + signum)

    atexit.register(cleanup)
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    tasks_file = os.path.join(HERE, "tasks.json")
    checker = os.path.join(HERE, "checks", "check.py")
    gen_fixture = os.path.join(HERE, "gen_fixture.py")
    for needed in (tasks_file, checker, gen_fixture):
        if not os.path.isfile(needed):
            die("bench-file-missing", needed)
    with open(tasks_file) as f:
        tasks = json.load(f)
    names = [t.strip() for t in args.tasks.split(",")] if args.tasks else list(tasks)
    for t in names:
        if t not in tasks:
            die("unknown-task", f"'{t}' not in {tasks_file}")

    prepare = None
    if gen_fixture:
        spec = importlib.util.spec_from_file_location("gen_fixture", gen_fixture)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        prepare = mod.prepare

    def fresh(arm, slot):
        if stopping.is_set():
            raise RunFail("runner stopped", "", "")
        d = os.path.join(work, "work", f"{arm}-{slot}")
        shutil.rmtree(d, ignore_errors=True)
        prepare(d)
        return d

    # --- generated dsh model patch (two rows) ---
    patch_file = os.path.join(work, "patches", f"model-{args.model}.yml")
    if "dsh" in kinds:
        os.makedirs(os.path.dirname(patch_file), exist_ok=True)
        sel = {"provider": dsh_cfg["provider"], "model": dsh_cfg["model"]}
        if dsh_cfg.get("reasoningEffort"):
            sel["reasoningEffort"] = dsh_cfg["reasoningEffort"]
        patch = [
            {"id": "llm-pi-ai", "name": "@deepseek-ai/dsh-llm-pi-ai",
             "config": {"providers": {dsh_cfg["provider"]: dsh_cfg["route"]}}},
            {"id": "agent-default-model", "name": "@deepseek-ai/dsh-agent-default-model", "config": sel},
        ]
        with open(patch_file, "w") as f:
            f.write(C.to_yaml(patch))

    # --- harness versions (no model calls) ---
    versions = {}
    venv = {**os.environ, "DSH_HOME": os.path.join(work, "homes", "version"), "DSH_TELEMETRY_MODE": "DISABLED"}
    if "dsh" in kinds:
        versions["dsh"] = subprocess.run([dsh_bin, "--version"], capture_output=True, text=True,
                                         timeout=60, env=venv).stdout.strip()
    if "sp" in kinds:
        versions["sp"] = subprocess.run([pi_bin, "--version"], capture_output=True, text=True, timeout=60).stdout.strip()
    if "cc" in kinds:
        versions["cc"] = subprocess.run(["claude", "--version"], capture_output=True, text=True, timeout=60).stdout.strip()

    # --- child process helper: hard timeout kills the whole process group ---
    def child(cmd, cwd, env, timeout):
        with live_lock:  # spawn and register under one lock, so a stop sees every child that exists
            if stopping.is_set():
                raise RunFail("runner stopped", "", "")
            p = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, start_new_session=True)
            live.add(p.pid)
        try:
            try:
                out, err = p.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(p.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                out, err = p.communicate()
                raise RunFail(f"timeout after {timeout}s", out or "", err or "")
        finally:
            with live_lock:
                live.discard(p.pid)
        return p.returncode, out, err

    def events_of(out):
        ev = []
        for line in out.splitlines():
            if line.startswith("{"):
                try:
                    ev.append(json.loads(line))
                except ValueError:
                    pass
        return ev

    # BENCH_LOG_DIR=<dir> keeps each run's raw event stream (keys scrubbed) as <arm>-<task>-<rep>.jsonl for analysis.
    log_dir = os.environ.get("BENCH_LOG_DIR")
    last_log = {}

    def keep_log(arm, slot, out, err):
        if log_dir:
            last_log[(arm, slot)] = scrub(out or "") + ("\n#stderr\n" + scrub(err or "")[-4000:] if err else "")

    def run_dsh(arm, slot, cwd, prompt):
        home = os.path.join(work, "homes", f"{arm}-{slot}")
        os.makedirs(home, exist_ok=True)
        env = {**os.environ, "DSH_HOME": home, "DSH_TELEMETRY_MODE": "DISABLED", key_env: key_val}
        if arm == "sdsh":
            env.update(sdsh_env)
        cmd = [dsh_bin, "headless", "--patch", patch_file]
        if arm == "sdsh":
            cmd += ["--patch", sdsh_patch]
        if arm in variants:
            cmd += ["--patch", variants[arm]]
        cmd += ["--json", "--permission-mode", "workspace-write", "--approval-policy", "never", prompt]
        try:
            rc, out, err = child(cmd, cwd, env, args.timeout)
        finally:
            shutil.rmtree(os.path.join(home, "sessions"), ignore_errors=True)
        keep_log(arm, slot, out, err)
        ev = events_of(out)
        u = dict(i=0, cr=0, cw=0, o=0, reasoning=0, turns=0, tools=0)
        final = None
        for e in ev:
            if e.get("type") == "status" and e.get("phase") == "step_end":
                x = e.get("usage") or {}
                u["i"] += x.get("inputTokens", 0)  # uncached input
                u["cr"] += x.get("cacheReadTokens", 0)
                u["cw"] += x.get("cacheWriteTokens", 0)
                u["o"] += x.get("outputTokens", 0)
                u["reasoning"] += x.get("reasoningTokens", 0)
            elif e.get("type") == "status" and e.get("phase") == "step_start":
                u["turns"] += 1
            elif e.get("type") == "tool_call":
                u["tools"] += 1
            elif e.get("type") == "final":
                final = e
        reason = ((final or {}).get("reason") or {}).get("kind")
        if rc != 0 or reason != "completed":
            raise RunFail(f"dsh exit {rc}, final reason {reason!r}: {scrub(err)[-200:]}", out, err)
        return u, (final or {}).get("text", "")

    def sp_agent_dir(slot):
        ad = os.path.join(work, "agents", f"sp-{slot}")
        if not os.path.isdir(ad):
            os.makedirs(ad)
            shutil.copy(os.path.join(C.PI_AGENT_DIR, "auth.json"), ad)
            shutil.copy(os.path.join(C.PI_AGENT_DIR, "models.json"), ad)
            with open(os.path.join(ad, "settings.json"), "w") as f:
                json.dump({"quietStartup": True, "packages": [C.STEAK_PI_PKG]}, f)
        return ad

    def run_sp(arm, slot, cwd, prompt):
        env = {**os.environ, "PI_CODING_AGENT_DIR": sp_agent_dir(slot)}
        cmd = [pi_bin, "-p", "--mode", "json", "--no-session"] + mcfg["sp"] + [prompt]
        rc, out, err = child(cmd, cwd, env, args.timeout)
        keep_log(arm, slot, out, err)
        ends = [e for e in events_of(out) if e.get("type") == "agent_end"]
        if rc != 0 or not ends:
            raise RunFail(f"pi exit {rc}, agent_end events {len(ends)}: {scrub(err)[-200:]}", out, err)
        u = dict(i=0, cr=0, cw=0, o=0, reasoning=0, turns=0, tools=0)
        text = ""
        for m in ends[-1].get("messages", []):
            if m.get("role") != "assistant":
                continue
            x = m.get("usage") or {}
            u["i"] += x.get("input", 0)  # uncached input
            u["cr"] += x.get("cacheRead", 0)
            u["cw"] += x.get("cacheWrite", 0)
            u["o"] += x.get("output", 0)
            u["reasoning"] += x.get("reasoning", 0)
            u["turns"] += 1
            for c in m.get("content", []):
                if c.get("type") in ("toolCall", "tool_call", "tool_use"):
                    u["tools"] += 1
            t = "".join(c.get("text", "") for c in m.get("content", []) if c.get("type") == "text")
            text = t or text
        return u, text

    def run_cc(arm, slot, cwd, prompt):
        cmd = ["claude", "-p"] + mcfg["cc"] + [
            "--no-session-persistence", "--setting-sources", "", "--disable-slash-commands",
            "--strict-mcp-config", "--no-chrome", "--permission-mode", "acceptEdits",
            "--allowedTools", "Bash,Read,Edit,Write,Glob,Grep", "--output-format", "json", prompt]
        rc, out, err = child(cmd, cwd, dict(os.environ), args.timeout)
        try:
            j = json.loads(out)
        except ValueError:
            j = None
        if rc != 0 or not isinstance(j, dict) or "usage" not in j:
            raise RunFail(f"claude exit {rc}: {scrub(err)[-200:]}", out, err)
        x = j["usage"]
        u = dict(i=x.get("input_tokens", 0), cr=x.get("cache_read_input_tokens", 0),
                 cw=x.get("cache_creation_input_tokens", 0), o=x.get("output_tokens", 0),
                 reasoning=None, turns=j.get("num_turns"), tools=None)
        return u, j.get("result", "")

    runners = {"dsh": run_dsh, "sp": run_sp, "cc": run_cc}

    def rate_limited(blob):
        return bool(re.search(r"(?<!\d)429(?!\d)", blob)) or "RATE_LIMIT" in blob

    def invoke(arm, slot, prompt):
        """One attempt per fresh fixture, with rate-limit retries (30 s, then 90 s; at most 2).
        Returns (u, text, err, retries, cwd)."""
        retries = 0
        while True:
            cwd = fresh(arm, slot)
            try:
                u, text = runners[kind(arm)](arm, slot, cwd, prompt)
                return u, text, "", retries, cwd
            except Exception as e:
                blob = scrub(str(e) + getattr(e, "out", "")[-4000:] + getattr(e, "err", "")[-4000:])
                if retries < 2 and rate_limited(blob):
                    time.sleep(30 if retries == 0 else 90)
                    retries += 1
                    continue
                return {}, "", scrub(repr(e))[:200], retries, cwd

    out_path = os.path.abspath(os.path.expanduser(args.out))
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    done = set()
    if os.path.exists(out_path):
        with open(out_path) as f:
            for line in f:
                r = json.loads(line)
                done.add((r["arm"], r.get("model"), r["task"], r["rep"]))

    jobs = []
    for rep in range(args.reps):
        for ti, t in enumerate(names):
            order = arms[(rep + ti) % len(arms):] + arms[:(rep + ti) % len(arms)]  # balanced per (rep, task)
            for a in order:
                if (a, args.model, t, rep) not in done:
                    jobs.append((rep, t, a))
    if not jobs:
        print(f"nothing to do: all {len(done)} requested rows already in {out_path}", flush=True)
        return

    lock = threading.Lock()

    def one(rep, task, arm, slot):
        if stopping.is_set():
            return
        t0 = time.time()
        u, text, err, retries, d = invoke(arm, slot, tasks[task])
        if stopping.is_set():
            return  # a run cut short by a stop is not a result: it is run again on resume
        with open(os.path.join(d, "ans.txt"), "w") as f:
            f.write(text)
        if log_dir and (arm, slot) in last_log:
            os.makedirs(log_dir, exist_ok=True)
            with open(os.path.join(log_dir, f"{arm}-{task}-{rep}.jsonl"), "w") as f:
                f.write(last_log.pop((arm, slot)))
        chk_err, chk = "", False
        try:
            c = subprocess.run([sys.executable, checker, task, "ans.txt"], cwd=d,
                               capture_output=True, text=True, timeout=120)
            chk = c.stdout.strip() == "true"
            if not chk:
                chk_err = scrub(c.stderr.strip())[:200]
        except Exception as e:
            chk_err = scrub(repr(e))[:200]
        row = dict(arm=arm, model=args.model, task=task, rep=rep, ok=(not err and chk),
                   sec=round(time.time() - t0, 1),
                   i=u.get("i", 0), cr=u.get("cr", 0), cw=u.get("cw", 0), o=u.get("o", 0),
                   reasoning=u.get("reasoning", 0), turns=u.get("turns", 0), tools=u.get("tools", 0),
                   err=err, chk_err=chk_err, retries=retries,
                   harness_version=versions.get(kind(arm), ""), ts=round(time.time()))
        with lock:
            if stopping.is_set():
                return
            with open(out_path, "a") as f:
                f.write(json.dumps(row) + "\n")
                f.flush()
            print(json.dumps(row), flush=True)

    slots = {a: queue.Queue() for a in arms}
    for a in arms:
        for k in range(args.par):
            slots[a].put(k)

    def job(x):
        rep, task, arm = x
        k = slots[arm].get()
        try:
            one(rep, task, arm, k)
        finally:
            slots[arm].put(k)

    def warm(x):
        arm, k = x
        _, _, err, _, _ = invoke(arm, k, WARM_PROMPT)
        if err:
            print(f"warm-up failed for {arm} lane {k}: {err}", file=sys.stderr, flush=True)
        return arm, err

    with ThreadPoolExecutor(args.par * len(arms)) as ex:
        warmed = list(ex.map(warm, [(a, k) for a in arms for k in range(args.par)]))
    # An arm that cannot answer one trivial request is misconfigured: stop before it fills the results with failures.
    for a in arms:
        errs = [e for arm, e in warmed if arm == a]
        if errs and all(errs):
            die("arm-cannot-run", f"every warm-up of arm '{a}' failed: {errs[0]}")
    with ThreadPoolExecutor(args.par * len(arms)) as ex:
        list(ex.map(job, jobs))


if __name__ == "__main__":
    main()
