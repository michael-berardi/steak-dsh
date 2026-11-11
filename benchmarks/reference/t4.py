from pathlib import Path

for p in Path("shop").glob("*.py"):
    s = p.read_text()
    if "calc_total" in s:
        p.write_text(s.replace("calc_total", "order_total"))
