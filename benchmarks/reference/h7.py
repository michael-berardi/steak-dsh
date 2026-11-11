from pathlib import Path

Path("wc.py").write_text('''import sys


def count(text):
    lines = text.count("\\n") + (1 if text and not text.endswith("\\n") else 0)
    return {"lines": lines, "words": len(text.split()), "chars": len(text)}


if __name__ == "__main__":
    c = count(open(sys.argv[1]).read())
    print(c["lines"], c["words"], c["chars"])
''')
with open("tools.txt", "a") as f:
    f.write("wc\n")
with open("README.md", "a") as f:
    f.write("- wc: python3 wc.py FILE prints the line, word and character counts of FILE.\n")
