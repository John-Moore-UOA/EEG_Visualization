"""V4: robustness against a hostile WebSocket feed (in-process server, phase-controlled), plus
resize storm and hidden/visible tab."""
import json
import threading
import time
from websockets.sync.server import serve
from playwright.sync_api import sync_playwright
import common as C

PORT = 8770
PHASE = {"name": "valid"}
TEN = ["Fp1", "Fp2", "F3", "F4", "C3", "C4", "P3", "P4", "O1", "O2"]


def full(vals_fn, units="uV^2", extra=None):
    bands = {}
    for bi, b in enumerate(["delta", "theta", "alpha", "beta", "gamma"]):
        bands[b] = {}
        for i, ch in enumerate(TEN + (extra or [])):
            bands[b][ch] = vals_fn(i, bi)
    return json.dumps({"type": "bandpower", "t": time.time(), "units": units, "bands": bands})


def payloads(name, k):
    w = 1 + 0.2 * ((k % 10) / 10)
    if name == "valid":
        return [full(lambda i, bi: (i + 1) * w * (bi + 1), extra=["TP9", "AF7", "Ch1"])]
    if name == "nan_literal":   # Python json.dumps writes NaN, which is not valid JSON
        return ['{"type":"bandpower","units":"uV^2","bands":{"alpha":{"Fp1":NaN,"Fp2":1,"O1":Infinity}}}']
    if name == "strings_nulls":
        return [json.dumps({"type": "bandpower", "units": "uV^2", "bands": {"alpha": {"Fp1": "12.3", "Fp2": None, "F3": [1], "F4": {"x": 1}, "C3": True, "C4": 1e400 if False else 5.0}}})]
    if name == "huge":
        return [full(lambda i, bi: 1e9 * (i + 1) * w)]
    if name == "volts":
        return [full(lambda i, bi: 1e-12 * (i + 1) * w)]
    if name == "negative":
        return [full(lambda i, bi: -5.0 + i * w)]
    if name == "garbage":
        return ["{}", "not json", "[1,2,3]", "null", "42", '"str"', b"\x00\x01binary", json.dumps({"type": "bandpower", "bands": None}), json.dumps({"bands": {"alpha": []}})]
    if name == "single_band":
        return [json.dumps({"band": "alpha", "values": {"Fp1": 3 * w, "O1": 9.0, "O2": 7.0, "C3": 1.0}})]
    if name == "flat":
        return [json.dumps({"Fp1": 0.42 * w, "Fp2": 0.37, "O1": 0.9, "O2": 0.8, "C3": 0.5})]
    if name == "relative":
        return [full(lambda i, bi: 0.2 * w * (i + 1) / 10, units="relative")]
    if name == "lowercase_names":
        return [json.dumps({"type": "bandpower", "units": "uV^2", "bands": {"alpha": {"fp1": 1.0, "FP2": 2.0, "o1": 3.0, "O2": 4.0}}})]
    if name == "one_channel":
        return [json.dumps({"type": "bandpower", "units": "uV^2", "bands": {"alpha": {"O1": 3.0 * w}}})]
    if name == "silent":
        return []
    return []


def handler(ws):
    k = 0
    try:
        while True:
            for msg in payloads(PHASE["name"], k):
                ws.send(msg)
            k += 1
            time.sleep(0.1)
    except Exception:
        pass


server = serve(handler, "localhost", PORT)
threading.Thread(target=server.serve_forever, daemon=True).start()

STATE = r"""() => {
  const V = __eeg.VIEW;
  let nanShown = false; for (const v of V.shown) if (!Number.isFinite(v)) nanShown = true;
  let nanDisp = false; for (const a of V.disp) for (const v of a) if (!Number.isFinite(v)) nanDisp = true;
  const vals = {}; for (const c of document.querySelectorAll('button.ch')) vals[c.dataset.name] = c.querySelector('.v').textContent;
  const sig = document.getElementById('signal');
  return {status: V.status, chip: document.getElementById('chip').textContent, active: V.active.map(e => e.name).join(','),
    unplaced: document.getElementById('unplaced').textContent, ticks: [...document.querySelectorAll('#ticks span')].map(s => s.textContent).join(' '),
    unit: document.getElementById('legendUnit').textContent, overlay: sig.hidden ? '' : sig.textContent, vals, nanShown, nanDisp,
    shownMax: Math.max(...V.shown), shownMin: Math.min(...V.shown), mean: document.getElementById('meanVal').textContent,
    asym: document.getElementById('asymVal').textContent, frames: __eeg.store.frames, bad: __eeg.source && __eeg.source.badMessages};
}"""

C.http()
L = C.Log()
R = {}
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=C.GPU_ARGS)
        pg = b.new_page(viewport={"width": 1440, "height": 900})
        L.attach(pg, "robust")
        pg.goto(C.BASE + "?degrade=0&source=ws&url=ws://localhost:%d" % PORT); pg.wait_for_timeout(2500)
        for ph in ["valid", "nan_literal", "strings_nulls", "huge", "volts", "negative", "garbage", "single_band",
                   "flat", "relative", "valid", "lowercase_names", "one_channel", "valid", "silent"]:
            PHASE["name"] = ph
            pg.wait_for_timeout(2500)
            R[ph + "_" + str(len(R))] = pg.evaluate(STATE)
            pg.screenshot(path=C.OUT + "/v4_%02d_%s.png" % (len(R), ph))
        # flat while user changes band: what is displayed as "beta"?
        PHASE["name"] = "flat"; pg.wait_for_timeout(1500)
        pg.select_option("#band", "beta"); pg.wait_for_timeout(1500)
        R["flat_after_select_beta"] = pg.evaluate(STATE)
        pg.select_option("#band", "alpha"); pg.wait_for_timeout(800)

        # resize storm with live data
        PHASE["name"] = "valid"; pg.wait_for_timeout(1000)
        for wh in [(320, 568), (375, 812), (760, 900), (1099, 700), (2560, 1440), (600, 300), (1440, 900)]:
            pg.set_viewport_size({"width": wh[0], "height": wh[1]}); pg.wait_for_timeout(180)
        pg.wait_for_timeout(800)
        R["after_resize"] = pg.evaluate(r"""() => ({canvas: [__eeg.renderer.domElement.width, __eeg.renderer.domElement.height], dpr: __eeg.renderer.getPixelRatio(), inner: [innerWidth, innerHeight], hscroll: document.documentElement.scrollWidth > innerWidth})""")
        for wh in [(320, 568), (375, 812)]:
            pg.set_viewport_size({"width": wh[0], "height": wh[1]}); pg.wait_for_timeout(600)
            R["hscroll_%d" % wh[0]] = pg.evaluate("() => ({sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, iw: innerWidth})")
        pg.set_viewport_size({"width": 1440, "height": 900}); pg.wait_for_timeout(500)

        # hidden / visible
        hid = r"""async (h) => {
          Object.defineProperty(document, 'hidden', {configurable: true, get: () => h});
          Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => h ? 'hidden' : 'visible'});
          document.dispatchEvent(new Event('visibilitychange'));
          const f0 = __eeg.renderer.info.render.frame, s0 = __eeg.store.frames;
          await new Promise(r => setTimeout(r, 2000));
          return {renderFrames: __eeg.renderer.info.render.frame - f0, storeFrames: __eeg.store.frames - s0, fpsText: document.getElementById('fps').textContent};
        }"""
        R["hidden"] = pg.evaluate(hid, True)
        R["visible"] = pg.evaluate(hid, False)
        pg.wait_for_timeout(300)
        R["visible_fps_text_after_300ms"] = pg.evaluate("() => document.getElementById('fps').textContent")
        b.close()
finally:
    server.shutdown()
    C.cleanup()

json.dump(R, open(C.OUT + "/v4_robust.json", "w", encoding="utf-8"), indent=1, ensure_ascii=False)
for k, v in R.items():
    print(k, json.dumps(v, ensure_ascii=True)[:900])
print("---- console ----")
for it in L.items:
    print(it[:3])
