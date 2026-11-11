from pathlib import Path

Path("conf.py").write_text('''import copy

DEFAULTS = {"retries": 3, "tags": []}


def make_conf(overrides=None):
    conf = copy.deepcopy(DEFAULTS)
    if overrides:
        conf.update(copy.deepcopy(overrides))
    return conf
''')
