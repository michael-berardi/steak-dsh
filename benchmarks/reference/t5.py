with open("util.py", "a") as f:
    f.write('''

def parse_kv(s):
    out = {}
    for seg in s.split(";"):
        if not seg.strip():
            continue
        if "=" not in seg:
            continue
        k, v = seg.split("=", 1)
        out[k.strip()] = v.strip()
    return out
''')
