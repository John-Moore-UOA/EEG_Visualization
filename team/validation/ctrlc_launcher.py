"""Runs INSIDE its own (hidden) console. Starts bridge.py --mock in the same console, connects a WS client,
then sends a real CTRL_C_EVENT to the whole console (this launcher ignores it) and records how the bridge exits."""
import json
import os
import signal
import subprocess
import sys
import threading
import time

signal.signal(signal.SIGINT, signal.SIG_IGN)
ROOT, OUT, PORT, WITH_CLIENT = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4] == "1"
log_path = os.path.join(OUT, "ctrlc_bridge_%d.log" % PORT)
log = open(log_path, "w")
proc = subprocess.Popen([sys.executable, "-u", "bridge.py", "--mock", "--port", str(PORT)], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
got = {"n": 0, "closed": None}


def client():
    from websockets.sync.client import connect
    for _ in range(50):
        try:
            with connect("ws://localhost:%d" % PORT) as ws:
                while True:
                    ws.recv()
                    got["n"] += 1
        except Exception as e:  # noqa: BLE001
            if got["n"]:
                got["closed"] = type(e).__name__ + ": " + str(e)[:120]
                return
            time.sleep(0.2)


if WITH_CLIENT:
    threading.Thread(target=client, daemon=True).start()
time.sleep(4.0)
t0 = time.time()
os.kill(0, signal.CTRL_C_EVENT)
try:
    code = proc.wait(timeout=20)
except subprocess.TimeoutExpired:
    code = "TIMEOUT (still running after 20 s)"
    proc.kill()
elapsed = time.time() - t0
time.sleep(0.5)
log.close()
res = {"port": PORT, "with_client": WITH_CLIENT, "exit_code": code, "exit_s": round(elapsed, 2), "msgs_received": got["n"], "client_close": got["closed"],
       "bridge_output": open(log_path).read()}
json.dump(res, open(os.path.join(OUT, "ctrlc_result_%d.json" % PORT), "w"), indent=1)
