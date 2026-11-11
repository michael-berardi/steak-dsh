from pathlib import Path

Path("util.py").write_text('''import re


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def chunk(xs, n):
    return [xs[i:i+n] for i in range(0, len(xs), n)]


def median(xs):
    xs = sorted(xs)
    m = len(xs) // 2
    if len(xs) % 2:
        return xs[m]
    return (xs[m-1] + xs[m]) / 2
''')
