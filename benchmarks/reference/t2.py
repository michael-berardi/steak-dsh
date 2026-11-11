import json

c = json.load(open("config.json"))
c["port"] = 9090
c["debug"] = True
open("config.json", "w").write(json.dumps(c))
