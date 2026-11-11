total = 0
with open("logs/server.log") as f:
    for line in f:
        p = line.split()
        if p[1] == "ERROR" and p[2] == "auth":
            total += int(p[-1].split("=")[1])
open("ans.txt", "w").write(f"The sum is {total}.\n")
