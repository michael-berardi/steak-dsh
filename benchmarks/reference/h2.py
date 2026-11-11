from pathlib import Path

Path("units/length.py").write_text('''FACTORS = {"m": 1.0, "cm": 0.01, "mm": 0.001, "km": 1000.0}


def to_meters(value, unit):
    return value * FACTORS[unit]
''')
Path("units/mass.py").write_text('''FACTORS = {"kg": 1.0, "g": 0.001, "mg": 0.000001}


def to_kgrams(value, unit):
    return value * FACTORS[unit]
''')
Path("units/convert.py").write_text('''from units.length import FACTORS as LENGTH
from units.length import to_meters
from units.mass import FACTORS as MASS
from units.mass import to_kgrams


def convert(value, src, dst):
    if src in LENGTH and dst in LENGTH:
        return round(to_meters(value, src) / LENGTH[dst], 6)
    if src in MASS and dst in MASS:
        return round(to_kgrams(value, src) / MASS[dst], 6)
    raise ValueError(f"unknown or mixed units: {src}->{dst}")
''')
