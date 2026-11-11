#!/usr/bin/env python3
"""Fixture setup: copy bench/fixture to <dest> and write the generated large files.

usage: python3 gen_fixture.py <dest>
The runner imports this module and calls prepare(dest).
Generation is deterministic (fixed seeds) and takes well under 2 seconds.
"""
import os
import random
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def _server_log(path):
    rng = random.Random(101)
    levels = ["INFO"] * 6 + ["WARN"] * 2 + ["ERROR", "DEBUG"]
    services = ["auth", "pay", "search", "cart"]
    words = ["request", "handled", "timeout", "retry", "cache", "miss", "hit",
             "connection", "reset", "queued", "done", "slow", "query"]
    out = []
    for i in range(42000):
        ts = f"2025-01-{1 + i % 28:02d}T{i % 24:02d}:{i % 60:02d}:{i % 59:02d}Z"
        level = rng.choice(levels)
        service = rng.choice(services)
        msg = " ".join(rng.choice(words) for _ in range(3))
        nbytes = rng.randrange(0, 50001)
        out.append(f"{ts} {level} {service} {msg} bytes={nbytes}")
    with open(path, "w") as f:
        f.write("\n".join(out) + "\n")


def _events_csv(path):
    rng = random.Random(202)
    users = ["vip_ana", "vip_ben", "vip_cy", "guest_di", "guest_ed", "u_fay",
             "vip_gus", "u_hal", "guest_ivy", "vip_jo"]
    actions = ["purchase", "purchase", "refund", "view", "view"]
    out = ["id,user,action,amount"]
    for i in range(80000):
        user = rng.choice(users)
        action = rng.choice(actions)
        cents = rng.randrange(0, 20001)
        out.append(f"{i},{user},{action},{cents // 100}.{cents % 100:02d}")
    with open(path, "w") as f:
        f.write("\n".join(out) + "\n")


def prepare(dest):
    """Copy the fixture to dest and write the generated large files."""
    dest = os.path.abspath(dest)
    shutil.copytree(os.path.join(HERE, "fixture"), dest, dirs_exist_ok=True)
    os.makedirs(os.path.join(dest, "logs"), exist_ok=True)
    os.makedirs(os.path.join(dest, "data"), exist_ok=True)
    _server_log(os.path.join(dest, "logs", "server.log"))
    _events_csv(os.path.join(dest, "data", "events.csv"))
    return dest


if __name__ == "__main__":
    prepare(sys.argv[1])
