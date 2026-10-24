"""V4b: fresh-page scenarios: volts-scale stream from the start; channel dropout mid-stream."""
import json
import threading
import time
from websockets.sync.server import serve
from playwright.sync_api import sync_playwright
import common as C

TEN = ["Fp1", "Fp2", "F3", "F4", "C3", "C4", "P3", "P4", "O1", "O2"]
MODE = {"m": "volts", "chans": TEN}


def handler(ws):
    k = 0
    try:
        while True:
            w = 1 + 0.3 * ((k % 20) / 20)
            bands = {}
            for bi, b in enumerate(["delta", "theta", "alpha", "beta", "gamma"]):
                bands[b] = {}
                for i, ch in enumerate(MODE["chans"]):
                    scale = 1e-12 if MODE["m"] == "volts" else 1.0
                    bands[b][ch] = scale * (i + 1) * w
            ws.send(json.dumps({"type": "bandpower", "t": time.time(), "units": "uV^2", "bands": bands}))
            k += 1
            time.sleep(0.1)
    except Exception:
        pass


server = serve(handler, "localhost", 8771)
threading.Thread(target=server.serve_forever, daemon=True).start()
ST = r"""() => ({status: __eeg.VIEW.status, ticks: [...document.querySelectorAll('#ticks span')].map(s => s.textContent).join(' '),
  shown: Array.from(__eeg.VIEW.shown).map(v => +v.toFixed(3)), active: __eeg.VIEW.active.map(e => e.name).join(','),
  vals: [...document.querySelectorAll('button.ch .v')].map(v => v.textContent).join(' '), overlay: document.getElementById('signal').hidden ? '' : document.getElementById('signal').textContent})"""
C.http()
R = {}
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=C.GPU_ARGS)
        pg = b.new_page(viewport={"width": 1440, "height": 900})
        pg.goto(C.BASE + "?degrade=0&source=ws&url=ws://localhost:8771"); pg.wait_for_timeout(3500)
        R["volts"] = pg.evaluate(ST)
        pg.screenshot(path=C.OUT + "/v4b_volts.png")
        pg.close()
        MODE["m"] = "uv"
        pg = b.new_page(viewport={"width": 1440, "height": 900})
        pg.goto(C.BASE + "?degrade=0&source=ws&url=ws://localhost:8771"); pg.wait_for_timeout(3000)
        R["ten"] = pg.evaluate(ST)
        MODE["chans"] = ["Fp1", "Fp2", "O1", "O2"]   # e.g. 6 electrodes dropped / bridge restarted with a subset
        pg.wait_for_timeout(4000)
        R["four_after_dropout"] = pg.evaluate(ST)
        pg.screenshot(path=C.OUT + "/v4b_dropout.png")
        b.close()
finally:
    server.shutdown()
    C.cleanup()
for k, v in R.items():
    print(k, json.dumps(v, ensure_ascii=True))
