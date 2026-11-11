from pathlib import Path

Path("textpipe/normalize.py").write_text('''import string


def clean(text):
    return " ".join(t.strip(string.punctuation) for t in text.lower().split())
''')
Path("textpipe/tokens.py").write_text('''def split(text):
    return [t for t in text.split() if t]
''')
Path("textpipe/summary.py").write_text('''from collections import Counter

from textpipe.normalize import clean
from textpipe.tokens import split


def summarize(text):
    toks = split(clean(text))
    counts = Counter(toks)
    top = min(counts, key=lambda w: (-counts[w], w)) if counts else ""
    return {"words": len(toks), "unique": len(counts), "top": top}
''')
