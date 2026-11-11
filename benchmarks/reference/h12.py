from pathlib import Path

p = Path("plugins/plugin_23.py")
p.write_text(p.read_text().replace("return x - OFFSET", "return x + OFFSET"))
