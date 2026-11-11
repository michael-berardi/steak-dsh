from units.length import to_meters


def test_meters():
    assert to_meters(2, "km") == 2000.0
    assert to_meters(5, "m") == 5.0


if __name__ == "__main__":
    test_meters()
    print("ok")
