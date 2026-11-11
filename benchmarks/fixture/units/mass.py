FACTORS = {"kg": 1.0, "g": 0.001, "mg": 0.001}


def to_kgrams(value, unit):
    return value * FACTORS[unit]
