from collections import Counter

from textpipe.normalize import clean
from textpipe.tokens import split


def summarize(text):
    toks = split(clean(text))
    counts = Counter(toks)
    top = max(counts, key=counts.get) if counts else ""
    return {"words": len(toks), "unique": len(counts), "top": top}
