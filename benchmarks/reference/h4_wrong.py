"""Obvious wrong fix: reverse=True sorts scores desc but also names desc on ties."""
from pathlib import Path

Path("ranking.py").write_text('''def rank(players):
    """players: list of (name, score). Names by score high->low, ties by name A->Z."""
    return [n for n, s in sorted(players, reverse=True)]
''')
