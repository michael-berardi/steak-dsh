from pathlib import Path

p = Path("shop/pricing.py")
s = p.read_text()
s = s.replace("    total = total - total * rate\n", "")
p.write_text(s)
