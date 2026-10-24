import sys
from playwright.sync_api import sync_playwright
q = sys.argv[1] if len(sys.argv) > 1 else "?degrade=0&clay=1"
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
    pg = b.new_page(viewport={"width": 1000, "height": 800})
    pg.goto("http://localhost:8000/index.html" + q); pg.wait_for_timeout(2500)
    for v in ["front", "left", "home"]:
        pg.evaluate("v => window.__eeg.goView(v)", v); pg.wait_for_timeout(1300)
        pg.screenshot(path="team/clay_%s.png" % v)
    b.close()
