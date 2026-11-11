from pathlib import Path

Path("shop/tax.py").write_text('''def with_tax(amount, rate=0.2):
    return round(amount * (1 + rate), 2)
''')
Path("shop/cli.py").write_text('''import sys

from shop.orders import checkout
from shop.pricing import calc_total
from shop.tax import with_tax


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "tax":
        amount = float(sys.argv[2])
        rate = float(sys.argv[3]) if len(sys.argv) > 3 else 0.2
        print(f"{with_tax(amount, rate):.2f}")
        return
    print(checkout([("pen", 2.5, 4)]), calc_total([("pen", 1.0, 1)]))


if __name__ == "__main__":
    main()
''')
with open("README.md", "a") as f:
    f.write("Tax: python3 -m shop.cli tax AMOUNT [RATE] prints the amount plus tax (default rate 0.2).\n")
