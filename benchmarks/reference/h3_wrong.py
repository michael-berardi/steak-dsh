"""Obvious wrong fix: shallow copy stops top-level leaks but shares the tags list."""
from pathlib import Path

Path("conf.py").write_text('''DEFAULTS = {"retries": 3, "tags": []}


def make_conf(overrides=None):
    conf = dict(DEFAULTS)
    if overrides:
        conf.update(overrides)
    return conf
''')
