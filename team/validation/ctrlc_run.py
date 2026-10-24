import json, os, subprocess, sys
import common as C
py = sys.executable
cases = [("sleep", 2, [py, "-u", os.path.join(C.OUT, "enable_ctrlc.py"), os.path.join(C.OUT, "ctrlc_control_sleep.py")]),
         ("async", 2, [py, "-u", os.path.join(C.OUT, "enable_ctrlc.py"), os.path.join(C.OUT, "ctrlc_control_async.py")]),
         ("bridge", 4, [py, "-u", os.path.join(C.OUT, "enable_ctrlc.py"), "bridge.py", "--mock", "--port", "8783"])]
for name, d, cmd in cases:
    subprocess.Popen([py, os.path.join(C.OUT, "ctrlc_generic.py"), C.OUT, name, str(d)] + cmd, creationflags=subprocess.CREATE_NO_WINDOW).wait(60)
    print(json.dumps(json.load(open(os.path.join(C.OUT, "ctrlc_%s.json" % name)))))
cases = [("bridge_client", 4, [py, "-u", os.path.join(C.OUT, "enable_ctrlc.py"), "bridge.py", "--mock", "--port", "8784"])]
for name, d, cmd in cases:
    subprocess.Popen([py, os.path.join(C.OUT, "ctrlc_generic.py"), C.OUT, name, str(d)] + cmd, creationflags=subprocess.CREATE_NO_WINDOW).wait(60)
    print(json.dumps(json.load(open(os.path.join(C.OUT, "ctrlc_%s.json" % name)))))
print("port 8783 open after:", C.port_open(8783))
