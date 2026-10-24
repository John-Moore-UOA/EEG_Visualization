import json, subprocess, sys, os, time
import common as C
res = []
for port, wc in ((8781, "1"), (8782, "0")):
    p = subprocess.Popen([sys.executable, os.path.join(C.OUT, "ctrlc_launcher.py"), C.ROOT, C.OUT, str(port), wc], creationflags=subprocess.CREATE_NO_WINDOW)
    p.wait(60)
    r = json.load(open(os.path.join(C.OUT, "ctrlc_result_%d.json" % port)))
    r["port_still_open"] = C.port_open(port)
    res.append(r)
print(json.dumps(res, indent=1))
