"""Shared helpers for the validation agent's tests (independent of the coder's scripts)."""
import os
import socket
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.dirname(os.path.abspath(__file__))
HTTP_PORT = 8100
BASE = "http://localhost:%d/index.html" % HTTP_PORT
GPU_ARGS = ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"]
PROCS = []


def port_open(port):
    s = socket.socket()
    s.settimeout(0.3)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def wait_port(port, timeout=15):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if port_open(port):
            return True
        time.sleep(0.2)
    return False


def start(args, name, port=None, **kw):
    log = open(os.path.join(OUT, name + ".log"), "w")
    p = subprocess.Popen([sys.executable, "-u"] + args, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, **kw)
    PROCS.append(p)
    if port:
        assert wait_port(port), name + " did not open port %d" % port
    return p


def http():
    if not port_open(HTTP_PORT):
        start(["-m", "http.server", str(HTTP_PORT), "--bind", "127.0.0.1"], "http", HTTP_PORT)


def bridge(port=8765, extra=(), name="bridge"):
    return start(["bridge.py", "--mock", "--port", str(port)] + list(extra), name + "_%d" % port, port)


def cleanup():
    for p in PROCS:
        if p.poll() is None:
            p.kill()
            p.wait(5)


class Log:
    def __init__(self):
        self.items = []

    def attach(self, page, tag):
        page.on("console", lambda m: self.items.append((tag, m.type, m.text, str(m.location))))
        page.on("pageerror", lambda e: self.items.append((tag, "pageerror", str(e), "")))
        page.on("requestfailed", lambda r: self.items.append((tag, "requestfailed", r.url + " " + str(r.failure), "")))
