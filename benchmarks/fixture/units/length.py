FACTORS = {"m": 1.0, "cm": 100.0, "mm": 0.001, "km": 1000.0}


def to_meters(value, unit):
    return value * FACTORS[unit]
