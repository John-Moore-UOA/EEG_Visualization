import json, subprocess, sys, time
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8011"], cwd=r"C:\Projects\Claude Animations", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=angle"])
        pg = b.new_page()
        pg.on("console", lambda m: print("CONSOLE", m.type, m.text[:200]))
        pg.goto("http://localhost:8011/team/avatar/probe.html")
        pg.wait_for_function("window.__probe", timeout=120000)
        print(json.dumps(pg.evaluate("window.__probe"), indent=1))
        b.close()
finally:
    srv.terminate()
