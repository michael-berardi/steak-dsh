from pathlib import Path

for p in Path("ledger").glob("*.py"):
    s = p.read_text()
    if "post_entry" in s:
        p.write_text(s.replace("post_entry", "record_entry"))
# restore the wire-format literal that must not be renamed
p = Path("ledger/labels.py")
p.write_text(p.read_text().replace('FIELD = "record_entry"', 'FIELD = "post_entry"'))
