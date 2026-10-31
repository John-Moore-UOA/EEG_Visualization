import json, subprocess, sys, time, base64
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8011"], cwd=r"C:\Projects\Claude Animations", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=angle","--enable-gpu"])
        pg = b.new_page(viewport={"width":1200,"height":800})
        pg.goto("http://localhost:8011/team/avatar/look.html")
        pg.wait_for_function("window.__ready", timeout=120000)
        print(json.dumps(pg.evaluate("window.__info")))
        for m in ["full","head","side"]:
            d = pg.evaluate(f"shot('{m}')")
            open(rf"C:\Projects\Claude Animations\team\avatar\look_{m}.png","wb").write(base64.b64decode(d.split(",")[1]))
        b.close()
finally:
    srv.terminate()
