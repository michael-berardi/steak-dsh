from textpipe import summarize


def test_words():
    assert summarize("Hello hello WORLD")["words"] == 3


if __name__ == "__main__":
    test_words()
    print("ok")
