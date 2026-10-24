"""V1: console / pageerror capture across all scenarios."""
import json
import time
from playwright.sync_api import sync_playwright
import common as C

C.http()
C.bridge(8765)
C.bridge(8766, ["--flat-band", "alpha"], "flat")
C.bridge(8768, ["--relative"], "rel")
L = C.Log()
summary = {}


def state(pg):
    return pg.evaluate("() => ({s: __eeg.VIEW.status, chip: document.getElementById('chip').innerText.split(String.fromCharCode(10)).join(' '),"
                       " sig: document.getElementById('signal').hidden ? '' : document.getElementById('signal').innerText.split(String.fromCharCode(10)).join(' '),"
                       " units: document.getElementById('legendUnit').textContent, n: __eeg.store.channels().length,"
                       " ticks: [...document.querySelectorAll('#ticks span')].map(s=>s.textContent).join(' ')})")


try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=C.GPU_ARGS)

        def run(tag, q, ms, action=None):
            ctx = b.new_context(viewport={"width": 1440, "height": 900})
            pg = ctx.new_page(); L.attach(pg, tag)
            pg.goto(C.BASE + q); pg.wait_for_timeout(ms)
            if action:
                action(pg)
            summary[tag] = state(pg)
            pg.screenshot(path=C.OUT + "/v1_" + tag + ".png")
            ctx.close()

        def bands(pg):
            for band in ["delta", "theta", "beta", "gamma", "alpha"]:
                pg.select_option("#band", band); pg.wait_for_timeout(900)
        run("default", "", 4000, bands)
        run("ember", "?cmap=ember", 3000, bands)
        run("m19", "?montage=19", 3000, bands)
        run("ws_live", "?source=ws&url=ws://localhost:8765", 4000, bands)
        run("ws_flat", "?source=ws&url=ws://localhost:8766", 4000, bands)
        run("ws_rel", "?source=ws&url=ws://localhost:8768", 4000, bands)
        run("ws_dead", "?source=ws&url=ws://localhost:9999", 9000)

        # kill + restart
        kp = C.bridge(8769, name="kill")
        ctx = b.new_context(viewport={"width": 1440, "height": 900})
        pg = ctx.new_page(); L.attach(pg, "kill_restart")
        pg.goto(C.BASE + "?source=ws&url=ws://localhost:8769"); pg.wait_for_timeout(3500)
        s_live = state(pg)
        kp.kill(); kp.wait()
        pg.wait_for_timeout(2500); s_dead = state(pg)
        pg.screenshot(path=C.OUT + "/v1_killed.png")
        pg.wait_for_timeout(6000)
        C.bridge(8769, name="restart")
        t0 = time.time()
        while time.time() - t0 < 25 and state(pg)["s"] != "live":
            pg.wait_for_timeout(250)
        s_back = state(pg); summary["kill_restart"] = {"live": s_live, "dead": s_dead, "back": s_back, "reconnect_s": round(time.time() - t0, 1)}
        ctx.close()
        b.close()
finally:
    C.cleanup()

print(json.dumps(summary, indent=1, ensure_ascii=False))
print("---- all console / errors ----")
for it in L.items:
    print(it)
