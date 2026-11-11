#!/usr/bin/env python3
"""Fixture test script. Run: python3 run_tests.py [conf|ranking]

With no argument every group runs. Exit code is non-zero if any test fails.
"""
import sys


def test_conf():
    import conf
    a = conf.make_conf({"retries": 9})
    assert a["retries"] == 9 and a["tags"] == []
    b = conf.make_conf()
    assert b == {"retries": 3, "tags": []}, "overrides leaked into later calls"
    c = conf.make_conf()
    c["tags"].append("x")
    c["retries"] = 99
    d = conf.make_conf()
    assert d == {"retries": 3, "tags": []}, "returned config shares state"
    assert conf.DEFAULTS == {"retries": 3, "tags": []}, "DEFAULTS was mutated"


def test_ranking():
    from ranking import rank
    assert rank([("zoe", 5), ("amy", 9)]) == ["amy", "zoe"]
    assert rank([("bob", 5), ("amy", 5), ("cid", 7)]) == ["cid", "amy", "bob"], "ties must be A->Z"
    assert rank([("b", 1), ("a", 1), ("c", 1)]) == ["a", "b", "c"]
    assert rank([]) == []
    assert rank([("solo", 0)]) == ["solo"]


GROUPS = {"conf": test_conf, "ranking": test_ranking}


def main():
    names = sys.argv[1:] or list(GROUPS)
    failed = 0
    for name in names:
        if name not in GROUPS:
            print(f"FAIL {name}: unknown group")
            failed += 1
            continue
        try:
            GROUPS[name]()
            print(f"PASS {name}")
        except AssertionError as e:
            print(f"FAIL {name}: {e}")
            failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
