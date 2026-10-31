import subprocess, sys, time, os
from playwright.sync_api import sync_playwright
ROOT = r"C:\Projects\Claude Animations"; OUT = os.path.join(ROOT, "team", "studio")
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8013"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); logs = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=angle", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"])
        pg = b.new_page(viewport={"width": 1440, "height": 900})
        pg.on("console", lambda m: logs.append(f"{m.type}: {m.text[:300]}")); pg.on("pageerror", lambda e: logs.append(f"PAGEERROR: {e}"))
        pg.goto("http://localhost:8013/studio/")
        pg.wait_for_function("window.__studio && window.__studio.ready", timeout=120000)
        pg.evaluate("__studio.S.autoShow=false"); time.sleep(4)
        # quality: loosen F4 for 12 s
        pg.evaluate("(() => { const s = __studio.subjects[0].source; const i = s.chan.findIndex(c => c.name === 'F4'); s._loose = { ch: i, until: s._t() + 14 }; })()")
        time.sleep(5); pg.click("#btnAudio"); time.sleep(0.5)
        pg.screenshot(path=os.path.join(OUT, "s_quality.png")); print("quality")
        pg.click("#btnSettings"); time.sleep(0.8); pg.screenshot(path=os.path.join(OUT, "s_drawer.png")); print("drawer")
        pg.keyboard.press("Escape"); time.sleep(0.3)
        pg.evaluate("__studio.setMode('network')"); time.sleep(6); pg.screenshot(path=os.path.join(OUT, "s_network2.png")); print("network2")
        print("audio on:", pg.evaluate("document.getElementById('btnAudio').getAttribute('aria-pressed')"))
        m = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        m.on("pageerror", lambda e: logs.append(f"PAGEERROR(m): {e}"))
        m.goto("http://localhost:8013/studio/"); m.wait_for_function("window.__studio && window.__studio.ready", timeout=120000)
        time.sleep(5); m.screenshot(path=os.path.join(OUT, "s_mobile.png")); print("mobile")
        b.close()
finally:
    srv.terminate(); print("\n".join(l for l in logs if 'FBXLoader' not in l) or "no console output")
