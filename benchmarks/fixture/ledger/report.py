from ledger.core import post_entry


def sample():
    return post_entry("sample", 0)["amount"]
