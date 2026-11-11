from units.length import FACTORS as LENGTH
from units.length import to_meters
from units.mass import FACTORS as MASS
from units.mass import to_kgrams


def convert(value, src, dst):
    if src in LENGTH and dst in LENGTH:
        return to_meters(value, src) / LENGTH[dst]
    if src in MASS and dst in MASS:
        return to_kgrams(value, src) / MASS[dst]
    raise KeyError(src)
