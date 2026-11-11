from pathlib import Path

Path("paid_total.py").write_text('''import csv

total = 0.0
with open("data.csv") as f:
    for row in csv.DictReader(f):
        if row["status"] == "paid":
            total += float(row["amount"])
print(f"{total:.2f}")
''')
