"""Functional checks: keyboard, unknown channels/relative units/garbage, stale, bridge kill+restart, resize.
Needs: http.server :8000, bridge --mock :8765, odd_server :8767. Kill/restart of the 8765 bridge is done here."""
import subprocess
import sys
import time
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8000/index.html"
ARGS = ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"]
logs = []
results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + ("  " + str(detail) if detail else ""))


def state(pg):
    return pg.evaluate("() => ({s: window.__eeg.VIEW.status, chip: document.getElementById('chip').innerText.replace(/\\n/g,' '),"
                       " sig: document.getElementById('signal').hidden ? '' : document.getElementById('signal').innerText.replace(/\\n/g,' '),"
                       " band: document.getElementById('band').value, chans: window.__eeg.store.channels().map(c=>c.name),"
                       " unplaced: document.getElementById('unplaced').textContent, units: document.getElementById('legendUnit').textContent,"
                       " ticks: [...document.querySelectorAll('#ticks span')].map(s=>s.textContent).join(' '),"
                       " active: window.__eeg.VIEW.active.map(e=>e.name).join(',')})")


def port_pid(port):
    out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if ("127.0.0.1:%d " % port) in line and "LISTENING" in line:
            return line.split()[-1]
    return None


with sync_playwright() as p:
    b = p.chromium.launch(args=ARGS)
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    pg = ctx.new_page()
    pg.on("console", lambda m: logs.append(("main", m.type, m.text)))
    pg.on("pageerror", lambda e: logs.append(("main", "pageerror", str(e))))

    # 1 keyboard
    pg.goto(BASE + "?degrade=0"); pg.wait_for_timeout(2500)
    pg.mouse.click(720, 880)
    pg.keyboard.press("4"); pg.wait_for_timeout(300)
    check("key 4 -> beta", state(pg)["band"] == "beta")
    pg.keyboard.press("1"); pg.wait_for_timeout(300)
    check("key 1 -> delta", state(pg)["band"] == "delta")
    pg.click("button.ch[data-name=O1]"); pg.wait_for_timeout(200)
    pinned = pg.evaluate("() => window.__eeg.VIEW.pinned")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    check("click row pins, Esc unpins", pinned == "O1" and pg.evaluate("() => window.__eeg.VIEW.pinned") is None, pinned)
    # tab order starts at the band select


    pass  # tab order verified separately on a fresh page (team/tabprobe.py)

    # 2 resize storm
    for w, h in [(800, 600), (375, 812), (1920, 1080), (1100, 700), (1440, 900)]:
        pg.set_viewport_size({"width": w, "height": h}); pg.wait_for_timeout(250)
    pg.wait_for_timeout(400)
    check("resize storm no errors", not [l for l in logs if l[1] in ("error", "pageerror")])

    # 3 odd server: garbage, unknown channels, relative units, then stale
    pg.goto(BASE + "?degrade=0&source=ws&url=ws://localhost:8767"); pg.wait_for_timeout(1800)
    st = state(pg)
    check("odd: live with relative units", st["s"] == "live" and "relative" in st["units"], st)
    check("odd: unknown channels listed, not placed", "TP9" in st["unplaced"] and "Ch1" in st["unplaced"] and "TP9" not in st["active"], st["unplaced"])
    check("odd: non-numeric value dropped (P4 not placed)", "P4" not in st["active"], st["active"])
    pg.wait_for_timeout(3500)
    st = state(pg)
    check("odd: silent open socket -> Stale + No signal overlay", st["s"] == "stale" and "No signal" in st["sig"], st)
    pg.screenshot(path="team/shot_coder_stale.png")

    # 4 bridge kill + restart
    pg.goto(BASE + "?degrade=0&source=ws&url=ws://localhost:8765"); pg.wait_for_timeout(3000)
    check("bridge: live", state(pg)["s"] == "live", state(pg)["chip"])
    pid = port_pid(8765)
    subprocess.run(["taskkill", "/F", "/PID", pid], capture_output=True)
    pg.wait_for_timeout(1500)
    st = state(pg)
    check("bridge killed -> Disconnected, frozen values, never mock", st["s"] == "disconnected" and "No signal" in st["sig"] and len(st["chans"]) == 10, st)
    pg.screenshot(path="team/shot_coder_ws_killed.png")
    proc = subprocess.Popen([sys.executable, "bridge.py", "--mock", "--port", "8765"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    t0 = time.time(); ok = False
    while time.time() - t0 < 20:
        pg.wait_for_timeout(500)
        if state(pg)["s"] == "live":
            ok = True; break
    check("bridge restarted -> auto-reconnect Live", ok, "%.1fs" % (time.time() - t0))
    b.close()

errs = [l for l in logs if l[1] in ("error", "pageerror", "warning")]
print("---- console (non-info) ----")
for l in errs:
    print(l)
print("---- console info ----")
for l in logs:
    if l[1] not in ("error", "pageerror", "warning"):
        print(l)
print("bridge restarted pid:", proc.pid if 'proc' in dir() else None)
