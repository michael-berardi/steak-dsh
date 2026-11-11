"""Shared constants and helpers for run.py and summarize.py. Python 3 stdlib only."""
import json
import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # bench/
REPO = os.path.dirname(HERE)

def _which(name):
    """Absolute path of an executable on PATH, or "" when it is not installed."""
    import shutil
    return shutil.which(name) or ""


# Nothing here is machine-specific: executables come from PATH, everything else from the environment.
DSH_BIN_DEFAULT = _which("dsh")                           # override: DSH_BIN
PI_BIN_DEFAULT = _which("pi")                             # override: PI_BIN (use a pi with no extensions injected)
STEAK_PI_PKG = os.environ.get("STEAK_PI_PACKAGE", "")     # path of the Steak Pi package, for the sp arm
SDSH_PATCH_DEFAULT = os.path.join(REPO, "cordis.patch.yml")
PI_AGENT_DIR = os.path.expanduser(os.environ.get("PI_CODING_AGENT_DIR", "~/.pi/agent"))
AUTH_PATH = os.path.join(PI_AGENT_DIR, "auth.json")

TOKEN_KEYS = ("i", "cr", "cw", "o")
# Used when every rate for a model is 0 (flat plan): a weighted token count instead of dollars.
WEIGHTS = {"i": 1.0, "cr": 0.1, "cw": 1.25, "o": 4.0}


def load_models():
    with open(os.path.join(HERE, "models.json")) as f:
        return json.load(f)


def all_zero(rates):
    return all(rates.get(k, 0) == 0 for k in TOKEN_KEYS)


def cost(row, rates):
    return sum(row.get(k, 0) * rates.get(k, 0) for k in TOKEN_KEYS)


def weighted(row):
    return sum(row.get(k, 0) * WEIGHTS[k] for k in TOKEN_KEYS)


def total_input(row):
    return row.get("i", 0) + row.get("cr", 0) + row.get("cw", 0)


def metric(row, rates):
    """Dollars from the one rate table, or weighted tokens when all rates are 0."""
    return weighted(row) if all_zero(rates) else cost(row, rates)


def metric_label(rates):
    return "weighted tokens" if all_zero(rates) else "cost $"


# --- tiny YAML emitter (stdlib only; enough for the dsh model patch) ---

def _yscalar(v):
    if v is True:
        return "true"
    if v is False:
        return "false"
    if v is None:
        return "null"
    if isinstance(v, (int, float)):
        return json.dumps(v)
    return json.dumps(str(v))  # JSON double-quoted strings are valid YAML scalars


def _emit(v, ind):
    pad = "  " * ind
    out = []
    if isinstance(v, dict):
        for k, val in v.items():
            if isinstance(val, dict) and val:
                out.append(f"{pad}{k}:")
                out.extend(_emit(val, ind + 1))
            elif isinstance(val, list) and val:
                out.append(f"{pad}{k}:")
                out.extend(_emit(val, ind + 1))
            elif isinstance(val, dict):
                out.append(f"{pad}{k}: {{}}")
            elif isinstance(val, list):
                out.append(f"{pad}{k}: []")
            else:
                out.append(f"{pad}{k}: {_yscalar(val)}")
    elif isinstance(v, list):
        for item in v:
            if isinstance(item, dict) and item:
                lines = _emit(item, ind + 1)
                out.append(pad + "- " + lines[0][len(pad) + 2:])
                out.extend(lines[1:])
            else:
                out.append(f"{pad}- {_yscalar(item)}")
    return out


def to_yaml(obj):
    return "\n".join(_emit(obj, 0)) + "\n"
