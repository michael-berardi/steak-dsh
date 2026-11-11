import csv

cents = 0
with open("data/events.csv") as f:
    for row in csv.DictReader(f):
        if row["action"] == "purchase" and row["user"].startswith("vip"):
            a, b = row["amount"].split(".")
            cents += int(a) * 100 + int(b)
open("ans.txt", "w").write(f"The total is {cents // 100}.{cents % 100:02d}.\n")
