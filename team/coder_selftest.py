"""Coder self-test: loads index.html via http://localhost:8000, collects console + page errors,
screenshots each band, WS live (bridge --mock on 8765), WS flat (bridge --flat-band on 8766),
dead WS port, 19-ch montage and a phone viewport.

Usage: python team/coder_selftest.py [which ...]   (default: all)
"""
import sys
import time
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8000/index.html"
OUT = "team/"
ARGS = ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"]

logs = []


def attach(page, tag):
    page.on("console", lambda m: logs.append((tag, m.type, m.text)))
    page.on("pageerror", lambda e: logs.append((tag, "pageerror", str(e))))


def shot(browser, tag, query, wait_s, viewport=(1440, 900), action=None):
    ctx = browser.new_context(viewport={"width": viewport[0], "height": viewport[1]}, device_scale_factor=1)
    page = ctx.new_page()
    attach(page, tag)
    page.goto(BASE + query, wait_until="load")
    page.wait_for_timeout(int(wait_s * 1000))
    if action:
        action(page)
    page.screenshot(path=OUT + "shot_coder_" + tag + ".png")
    info = page.evaluate("""() => { const e = window.__eeg; if (!e) return null;
        const r = e.renderer.info.render; return {status: e.VIEW.status, chans: e.store.channels().map(c => c.name),
        units: e.store.units, frames: e.store.frames, calls: r.calls, tris: r.triangles,
        fps: document.getElementById('fps').textContent, chip: document.getElementById('chip').innerText.replace(/\\n/g,' ')}; }""")
    print(tag, info)
    ctx.close()


def main():
    which = set(sys.argv[1:]) or {"bands", "ws", "flat", "dead", "m19", "phone", "hover"}
    with sync_playwright() as p:
        browser = p.chromium.launch(args=ARGS)
        if "bands" in which:
            for band in ["delta", "theta", "alpha", "beta", "gamma"]:
                shot(browser, band, "?degrade=0&band=" + band, 6)
            shot(browser, "alpha_ember", "?degrade=0&cmap=ember", 6)
        if "hover" in which:
            def hover(page):
                page.hover("button.ch[data-name=O1]")
                page.wait_for_timeout(800)
            shot(browser, "hover", "?degrade=0", 6, action=hover)
            def back(page):
                page.click("[data-view=back]")
                page.wait_for_timeout(1500)
            shot(browser, "back", "?degrade=0", 5, action=back)
            def switch(page):
                page.select_option("#band", "beta")
                page.wait_for_timeout(330)
            shot(browser, "sweep", "?degrade=0", 5, action=switch)
        if "ws" in which:
            shot(browser, "ws_live", "?degrade=0&source=ws&url=ws://localhost:8765", 7)
        if "flat" in which:
            shot(browser, "ws_flat", "?degrade=0&source=ws&url=ws://localhost:8766", 7)
        if "dead" in which:
            shot(browser, "ws_dead", "?degrade=0&source=ws&url=ws://localhost:8799", 5)
        if "views" in which:
            for v in ["front", "left", "top", "back"]:
                def act(page, v=v):
                    page.click("[data-view=%s]" % v)
                    page.wait_for_timeout(1500)
                shot(browser, "view_" + v, "?degrade=0", 4, action=act)
        if "m19" in which:
            shot(browser, "m19", "?degrade=0&montage=19", 6)
        if "phone" in which:
            shot(browser, "phone", "?degrade=0", 6, viewport=(375, 812))
        browser.close()
    print("---- console ----")
    for tag, typ, text in logs:
        print(f"[{tag}] {typ}: {text}")


if __name__ == "__main__":
    main()
