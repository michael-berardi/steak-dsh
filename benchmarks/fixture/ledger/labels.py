from ledger.core import post_entry

FIELD = "post_entry"


def label_for(name):
    return f"{FIELD}:{name}"


def tagged(name, amount):
    return {FIELD: post_entry(name, amount)}
