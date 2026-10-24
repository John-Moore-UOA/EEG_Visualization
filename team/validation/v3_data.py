"""V3: end-to-end data correctness against bridge --mock: table vs last WS message, store maths,
spline value at electrodes, rendered pixel colour vs colormap, band switch changes the data source band."""
import json
from playwright.sync_api import sync_playwright
import common as C

# Independent tap on every WebSocket message the page receives.
INIT = r"""
(() => {
  const N = window.WebSocket;
  window.__msgs = [];
  window.WebSocket = function (u, p) {
    const ws = p === undefined ? new N(u) : new N(u, p);
    ws.addEventListener('message', ev => { window.__last = ev.data; window.__msgs.push(ev.data); if (window.__msgs.length > 50) window.__msgs.shift(); });
    return ws;
  };
  window.WebSocket.prototype = N.prototype;
  Object.assign(window.WebSocket, {CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3});
})();
"""
HOOK = r"""
() => { const r = __eeg.renderer, o = r.render; r.render = function (s, c) { if (c && c.isPerspectiveCamera) { window.__cam = c; window.__scene = s; } return o.call(this, s, c); }; return true; }
"""
COMPARE = r"""
(band) => {
  const msg = JSON.parse(window.__last), vals = msg.bands[band];
  const out = {band, rows: [], range: __eeg.store.range(band)};
  const rng = __eeg.store.range(band), span = Math.max(rng.hi - rng.lo, Math.abs(rng.hi) * 1e-6, 1e-30);
  for (const c of document.querySelectorAll('button.ch')) {
    const n = c.dataset.name, txt = c.querySelector('.v').textContent;
    const e = __eeg.VIEW.active.find(x => x.name === n);
    const norm = Math.min(1, Math.max(0, (vals[n] - rng.lo) / span));
    out.rows.push({n, table: txt, msg: vals[n], storeRaw: __eeg.store.raw(band, n), storeNorm: __eeg.store.norm(band, n), myNorm: norm, shown: __eeg.VIEW.shown[e.idx]});
  }
  return out;
}
"""
SPLINE = r"""
() => {
  let shell = null; window.__scene.traverse(o => { if (o.isMesh && o.material.isShaderMaterial) shell = o; });
  const D = shell.geometry.attributes.aDir.array, A = shell.geometry.attributes.aVal.array, M = shell.geometry.attributes.aMask.array;
  const res = {};
  for (const e of __eeg.VIEW.active) {
    let best = -2, bi = -1; const d = e.m.dir;
    for (let i = 0; i < A.length; i++) { const c = D[i*3]*d[0] + D[i*3+1]*d[1] + D[i*3+2]*d[2]; if (c > best) { best = c; bi = i; } }
    res[e.name] = {shown: __eeg.VIEW.shown[e.idx], aVal: A[bi], mask: M[bi], angDeg: Math.acos(Math.min(1, best)) * 180 / Math.PI};
  }
  return res;
}
"""
PROJECT = r"""
async () => {
  const cam = window.__cam, out = {};
  for (const e of __eeg.VIEW.active) {
    const p = e.pos.clone().addScaledVector(e.nrm, -0.012 + 0.008);
    const v = p.clone().project(cam);
    const camDir = cam.position.clone().sub(p).normalize();
    out[e.name] = {x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight, facing: camDir.dot(e.nrm), shown: __eeg.VIEW.shown[e.idx]};
  }
  return out;
}
"""
HIDE = r"""
(what) => {
  window.__scene.traverse(o => {
    const isElectrodePart = o.isSprite || (o.isMesh && o.parent && o.parent.isGroup && o.parent.parent && o.parent.parent.isGroup && ['CylinderGeometry','TorusGeometry','SphereGeometry'].includes(o.geometry.type) && o.geometry.parameters.radius !== 1);
    if (what.includes('el') && isElectrodePart) o.visible = false;
    if (what.includes('shell') && o.isMesh && o.material.isShaderMaterial) o.visible = false;
  });
  document.querySelector('#gl .labels').style.display = 'none';
  document.getElementById('overlay').style.display = 'none';
  return true;
}
"""
# Colormap re-derived from the legend's CSS gradient (independent of the page's lut()).
LUT = r"""(t) => {
  const css = getComputedStyle(document.getElementById('legendBar')).backgroundImage;
  const stops = [...css.matchAll(/rgb\((\d+), (\d+), (\d+)\)/g)].map(m => [+m[1], +m[2], +m[3]]);
  const s = Math.min(1, Math.max(0, t)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(s)), f = s - i;
  return stops[i].map((a, k) => a + (stops[i + 1][k] - a) * f);
}"""


def s2l(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def l2s(c):
    c = max(0.0, min(1.0, c))
    return 255 * (c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055)


C.http()
C.bridge(8765)
R = {}
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=C.GPU_ARGS)
        ctx = b.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        ctx.add_init_script(INIT)
        pg = ctx.new_page()
        pg.goto(C.BASE + "?degrade=0&source=ws&url=ws://localhost:8765"); pg.wait_for_timeout(4000)
        pg.evaluate(HOOK)
        R["alpha"] = pg.evaluate(COMPARE, "alpha")
        pg.select_option("#band", "beta"); pg.wait_for_timeout(1500)
        R["beta"] = pg.evaluate(COMPARE, "beta")
        R["msg_count"] = pg.evaluate("() => window.__msgs.length")
        R["spline_live"] = pg.evaluate(SPLINE)
        # freeze the data, then pin the status the renderer reads to 'live' so saturation stays 1
        pg.evaluate("() => { __eeg.source.stop(); setInterval(() => { __eeg.VIEW.status = 'live'; }, 1); }")
        pg.evaluate("() => __eeg.goView('top')"); pg.wait_for_timeout(3000)
        R["spline_frozen"] = pg.evaluate(SPLINE)
        R["proj"] = pg.evaluate(PROJECT)
        R["lut"] = {}
        for n, d in R["proj"].items():
            R["lut"][n] = pg.evaluate(LUT, d["shown"])
        R["sat"] = pg.evaluate("() => __eeg.VIEW.sat")
        pg.evaluate(HIDE, ["el"]); pg.wait_for_timeout(300)
        pg.screenshot(path=C.OUT + "/v3_shell_only.png")
        pg.evaluate(HIDE, ["el", "shell"]); pg.wait_for_timeout(300)
        pg.screenshot(path=C.OUT + "/v3_skull_only.png")
        b.close()
finally:
    C.cleanup()
json.dump(R, open(C.OUT + "/v3_data.json", "w"), indent=1)

for band in ["alpha", "beta"]:
    print("==", band, "range", R[band]["range"])
    for r in R[band]["rows"]:
        print("  %-4s table=%-7s msg=%-10s storeRaw=%-10s storeNorm=%.3f myNorm=%.3f shown=%.3f" % (r["n"], r["table"], r["msg"], r["storeRaw"], r["storeNorm"], r["myNorm"], r["shown"]))
print("messages captured:", R["msg_count"], "sat", R["sat"])
print("== spline at electrodes (frozen)")
for n, d in R["spline_frozen"].items():
    print("  %-4s shown=%.4f aVal=%.4f diff=%.4f mask=%.3f nearestVertexDeg=%.2f" % (n, d["shown"], d["aVal"], d["aVal"] - d["shown"], d["mask"], d["angDeg"]))

from PIL import Image
A = Image.open(C.OUT + "/v3_shell_only.png").convert("RGB")
B = Image.open(C.OUT + "/v3_skull_only.png").convert("RGB")
print("== pixel check (top view), expected = linear alpha-blend of lut(shown) over the skull pixel")
for n, d in R["proj"].items():
    if d["facing"] < 0.5:
        continue
    x, y = int(round(d["x"])), int(round(d["y"]))
    px = A.getpixel((x, y)); bg = B.getpixel((x, y))
    a = R["spline_frozen"][n]["mask"]
    lutc = R["lut"][n]
    exp = [l2s(a * s2l(lutc[k]) + (1 - a) * s2l(bg[k])) for k in range(3)]
    err = max(abs(exp[k] - px[k]) for k in range(3))
    print("  %-4s facing=%.2f px=%s bg=%s lut=%s alpha=%.2f expected=%s maxErr=%.1f" % (n, d["facing"], px, bg, [round(c) for c in lutc], a, [round(c) for c in exp], err))
