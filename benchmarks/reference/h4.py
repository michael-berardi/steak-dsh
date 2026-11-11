from pathlib import Path

Path("ranking.py").write_text('''def rank(players):
    """players: list of (name, score). Names by score high->low, ties by name A->Z."""
    return [n for n, s in sorted(players, key=lambda p: (-p[1], p[0]))]
''')
