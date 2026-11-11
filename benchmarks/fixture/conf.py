DEFAULTS = {"retries": 3, "tags": []}


def make_conf(overrides=None):
    conf = DEFAULTS
    if overrides:
        conf.update(overrides)
    return conf
