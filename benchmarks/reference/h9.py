from pathlib import Path

p = Path("bigreport.py")
s = p.read_text()
s = s.replace('    return "= REPORT ="', '    return "== REPORT =="')
s = s.replace('    return f"Total: {n + 1}"', '    return f"Total: {n}"')
p.write_text(s)
