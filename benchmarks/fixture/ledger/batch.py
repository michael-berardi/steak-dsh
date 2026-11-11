from ledger.core import post_entry


def submit_all(rows):
    return [post_entry(n, a) for n, a in rows]
