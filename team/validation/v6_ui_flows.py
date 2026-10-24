"""V6: UI source-switch flows: Mock -> WebSocket radio -> Connect (bridge), Disconnect, invalid URL, ?ws= alias,
montage toggle; band switch in --flat-band mode against the real bridge."""
import json
from playwright.sync_api import sync_playwright
import common as C

ST = r"""() => ({status: __eeg.VIEW.status, chip: document.getElementById('chip').innerText.split(String.fromCharCode(10)).join(' '),
  overlay: document.getElementById('signal').hidden ? '' : document.getElementById('signal').innerText.split(String.fromCharCode(10)).join(' '),
  n: __eeg.store.channels().length, active: __eeg.VIEW.active.length, btn: document.getElementById('wsBtn').textContent,
  vals: [...document.querySelectorAll('button.ch')].map(b => b.dataset.name + '=' + b.querySelector('.v').textContent).join(' '),
  sub: document.getElementById('subtitle').textContent, band: document.getElementById('band').value})"""
C.http()
C.bridge(8765)
C.bridge(8766, ["--flat-band", "alpha"], "flat")
R = {}
L = C.Log()
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=C.GPU_ARGS)
        pg = b.new_page(viewport={"width": 1440, "height": 900}); L.attach(pg, "ui")
        pg.goto(C.BASE); pg.wait_for_timeout(2000)
        pg.click("label[for=mont19]"); pg.wait_for_timeout(1500); R["mont19"] = pg.evaluate(ST)
        pg.click("label[for=srcWs]"); pg.wait_for_timeout(800); R["ws_selected_not_connected"] = pg.evaluate(ST)
        pg.click("#wsBtn"); pg.wait_for_timeout(500); R["ws_connect_0.5s"] = pg.evaluate(ST)
        pg.wait_for_timeout(2500); R["ws_connect_3s"] = pg.evaluate(ST)
        pg.click("#wsBtn"); pg.wait_for_timeout(1500); R["ws_disconnect"] = pg.evaluate(ST)
        pg.fill("#wsUrl", "http://nope"); pg.click("#wsBtn"); pg.wait_for_timeout(800); R["invalid_url"] = pg.evaluate(ST)
        pg.fill("#wsUrl", "ws://"); pg.click("#wsBtn"); pg.wait_for_timeout(300); pg.click("#wsBtn"); pg.wait_for_timeout(800); R["invalid_url2"] = pg.evaluate(ST)
        pg.click("label[for=srcMock]"); pg.wait_for_timeout(1500); R["back_to_mock"] = pg.evaluate(ST)
        pg.close()
        pg = b.new_page(viewport={"width": 1440, "height": 900}); L.attach(pg, "alias")
        pg.goto(C.BASE + "?ws=ws://localhost:8765"); pg.wait_for_timeout(3000); R["ws_alias"] = pg.evaluate(ST)
        pg.close()
        pg = b.new_page(viewport={"width": 1440, "height": 900}); L.attach(pg, "flat")
        pg.goto(C.BASE + "?source=ws&url=ws://localhost:8766"); pg.wait_for_timeout(3000); R["flat_alpha"] = pg.evaluate(ST)
        pg.select_option("#band", "beta"); pg.wait_for_timeout(2000); R["flat_then_beta"] = pg.evaluate(ST)
        pg.screenshot(path=C.OUT + "/v6_flat_labelled_beta.png")
        b.close()
finally:
    C.cleanup()
for k, v in R.items():
    print(k, json.dumps(v, ensure_ascii=True))
print("---- console ----")
for it in L.items:
    print(it[:3])
