"""Studio smoke test: console errors + screenshots across modes. Usage: python shoot.py [names...]"""
import json, subprocess, sys, time, os
from playwright.sync_api import sync_playwright
ROOT = r"C:\Projects\Claude Animations"; OUT = os.path.join(ROOT, "team", "studio")
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8012"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
which = set(sys.argv[1:])
logs = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=angle", "--enable-gpu", "--ignore-gpu-blocklist"])
        pg = b.new_page(viewport={"width": 1440, "height": 900})
        pg.on("console", lambda m: logs.append(f"{m.type}: {m.text[:300]}"))
        pg.on("pageerror", lambda e: logs.append(f"PAGEERROR: {e}"))
        pg.goto("http://localhost:8012/studio/?theme=dusk")
        pg.wait_for_function("window.__studio && window.__studio.ready", timeout=120000)
        pg.evaluate("window.__studio.S.autoShow=false")
        def shot(name, js=None, wait=1.0):
            if which and name not in which: return
            if js: pg.evaluate(js)
            time.sleep(wait)
            pg.screenshot(path=os.path.join(OUT, f"s_{name}.png"))
            print("shot", name)
        time.sleep(4.5)  # intro flight + data warmup
        shot("portrait")
        shot("left", "__studio.flyTo('left')", 2.2)
        shot("crown", "__studio.flyTo('crown')", 2.2)
        shot("back", "__studio.flyTo('back')", 2.2)
        shot("full", "__studio.flyTo('full')", 2.4)
        shot("network", "__studio.setSim('focus'); __studio.setMode('network'); __studio.setBand('beta')", 9.0)
        shot("feedback", "__studio.setMode('feedback'); __studio.setSim('relax')", 6.0)
        shot("duo", "__studio.setBand('alpha'); __studio.setSim('auto'); __studio.setMode('duo')", 9.0)
        shot("duoleft", "__studio.flyTo('left')", 2.5)
        shot("delta", "__studio.setMode('topo'); __studio.setSim('rest'); __studio.calibrate(true); setTimeout(()=>__studio.setSim('relax'), 21000)", 27.0)
        shot("clinical", "__studio.setMode('topo'); __studio.setTheme('clinical')", 3.0)
        shot("holo", "__studio.setTheme('aurora'); __studio.setFinish('hologram')", 2.0)
        print(json.dumps(pg.evaluate("({fps: 0, ch: __studio.subjects[0].store.list.length, active: __studio.subjects[0].topo.active.length, capN: __studio.subjects[0].topo.cap.n, r: __studio.subjects[0].topo.r})")))
        b.close()
finally:
    srv.terminate()
    print("\n".join(l for l in logs if not l.startswith("debug")) or "no console output")
