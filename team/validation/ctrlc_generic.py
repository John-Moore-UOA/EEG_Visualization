"""Runs inside its own hidden console: starts a target, sends CTRL_C_EVENT to the console, records exit."""
import json, os, signal, subprocess, sys, time
signal.signal(signal.SIGINT, lambda *a: None)   # launcher survives Ctrl+C without setting the inherited ignore flag
out, name, delay = sys.argv[1], sys.argv[2], float(sys.argv[3])
cmd = sys.argv[4:]
log_path = os.path.join(out, "ctrlc_%s.log" % name)
log = open(log_path, "w")
proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, cwd=os.path.abspath(os.path.join(out, "..", "..")))
import threading
got = {"n": 0, "end": None}
def client(port):
    from websockets.sync.client import connect
    for _ in range(50):
        try:
            with connect("ws://localhost:%d" % port) as ws:
                while True:
                    ws.recv(); got["n"] += 1
        except Exception as e:
            if got["n"]:
                got["end"] = type(e).__name__ + ": " + str(e)[:100]; return
            time.sleep(0.2)
if "client" in name:
    threading.Thread(target=client, args=(int(cmd[-1]),), daemon=True).start()
time.sleep(delay)
t0 = time.time()
os.kill(0, signal.CTRL_C_EVENT)
try:
    code = proc.wait(timeout=15)
except subprocess.TimeoutExpired:
    code = "TIMEOUT"
    proc.kill()
el = time.time() - t0
log.close()
json.dump({"name": name, "exit": code, "secs": round(el, 2), "out": open(log_path).read()[-1500:], "client_msgs": got["n"], "client_end": got["end"]}, open(os.path.join(out, "ctrlc_%s.json" % name), "w"), indent=1)
