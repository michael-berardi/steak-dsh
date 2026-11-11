from ledger.core import post_entry


def submit(name, amount):
    return post_entry(name, amount)
