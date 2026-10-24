"""V3b: independent Perrin spline (numpy) vs the page's shell values; pixel colour vs lut(aVal) incl. the
documented grazing shading. Uses the in-page mock (10 and 19 ch), frozen."""
import json
import math
import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright
import common as C

HOOK = r"""
() => { const r = __eeg.renderer, o = r.render; r.render = function (s, c) { if (c && c.isPerspectiveCamera) { window.__cam = c; window.__scene = s; } return o.call(this, s, c); }; return true; }
"""
DUMP = r"""
() => {
  let shell = null; window.__scene.traverse(o => { if (o.isMesh && o.material.isShaderMaterial) shell = o; });
  const g = shell.geometry, D = g.attributes.aDir.array, A = g.attributes.aVal.array, M = g.attributes.aMask.array, P = g.attributes.position.array, Nn = g.attributes.normal.array;
  const cam = window.__cam, el = [];
  for (const e of __eeg.VIEW.active) el.push({name: e.name, dir: e.m.dir, shown: __eeg.VIEW.shown[e.idx]});
  // sample: nearest vertex to each electrode + 400 random vertices
  const pick = [];
  for (const e of el) { let best = -2, bi = -1; for (let i = 0; i < A.length; i++) { const c = D[i*3]*e.dir[0] + D[i*3+1]*e.dir[1] + D[i*3+2]*e.dir[2]; if (c > best) { best = c; bi = i; } } pick.push(bi); }
  for (let k = 0; k < 400; k++) pick.push(Math.floor(Math.random() * A.length));
  const verts = pick.map(i => {
    const v = new cam.position.constructor(P[i*3], P[i*3+1], P[i*3+2]);
    const view = cam.position.clone().sub(v).normalize();
    const ndv = Math.max(0, view.x * Nn[i*3] + view.y * Nn[i*3+1] + view.z * Nn[i*3+2]);
    const s = v.clone().project(cam);
    return {i, dir: [D[i*3], D[i*3+1], D[i*3+2]], aVal: A[i], mask: M[i], ndv, x: (s.x + 1) / 2 * innerWidth, y: (1 - s.y) / 2 * innerHeight, depth: s.z};
  });
  return {el, verts, uOpacity: shell.material.uniforms.uOpacity.value, nverts: A.length};
}
"""
LUTS = r"""(ts) => {
  const css = getComputedStyle(document.getElementById('legendBar')).backgroundImage;
  const stops = [...css.matchAll(/rgb\((\d+), (\d+), (\d+)\)/g)].map(m => [+m[1], +m[2], +m[3]]);
  return ts.map(t => { const s = Math.min(1, Math.max(0, t)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(s)), f = s - i;
    return stops[i].map((a, k) => a + (stops[i + 1][k] - a) * f); });
}"""
HIDE = r"""
(what) => {
  window.__scene.traverse(o => {
    const isEl = o.isSprite || (o.isMesh && o.parent && o.parent.isGroup && o.parent.parent && o.parent.parent.isGroup && o.geometry.parameters && o.geometry.parameters.radius !== 1 && ['CylinderGeometry','TorusGeometry','SphereGeometry'].includes(o.geometry.type));
    if (what.includes('el') && isEl) o.visible = false;
    if (what.includes('shell') && o.isMesh && o.material.isShaderMaterial) o.visible = false;
  });
  document.querySelector('#gl .labels').style.display = 'none';
  document.getElementById('overlay').style.display = 'none';
  return true;
}
"""


def s2l(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def l2s(c):
    c = max(0.0, min(1.0, c))
    return 255 * (c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055)


def g(x):
    p0, p1, s = 1.0, x, 0.0
    for n in range(1, 41):
        if n == 1:
            pn = x
        else:
            pn = ((2 * n - 1) * x * p1 - (n - 1) * p0) / n
            p0, p1 = p1, pn
        s += (2 * n + 1) / (n * (n + 1)) ** 4 * pn
    return s / (4 * math.pi)


def spline_eval(E, vals, q, lam=1e-5):
    N = len(E)
    A = np.zeros((N + 1, N + 1))
    for i in range(N):
        for j in range(N):
            A[i, j] = g(float(np.dot(E[i], E[j]))) + (lam if i == j else 0)
        A[i, N] = A[N, i] = 1
    rhs = np.append(vals, 0)
    sol = np.linalg.solve(A, rhs)
    c, c0 = sol[:N], sol[N]
    out = []
    for qq in q:
        out.append(c0 + sum(c[j] * g(float(np.clip(np.dot(E[j], qq), -1, 1))) for j in range(N)))
    return np.array(out)


C.http()
R = {}
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=C.GPU_ARGS)
        for mont in ["10", "19"]:
            pg = b.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
            pg.goto(C.BASE + "?degrade=0&montage=" + mont); pg.wait_for_timeout(3000)
            pg.evaluate(HOOK)
            pg.evaluate("() => { __eeg.source.stop(); __eeg.goView('top'); }"); pg.wait_for_timeout(2500)
            d = pg.evaluate(DUMP)
            d["lut"] = pg.evaluate(LUTS, [v["aVal"] for v in d["verts"]])
            pg.evaluate(HIDE, ["el"]); pg.wait_for_timeout(300)
            pg.screenshot(path=C.OUT + "/v3b_shell_%s.png" % mont)
            pg.evaluate(HIDE, ["el", "shell"]); pg.wait_for_timeout(300)
            pg.screenshot(path=C.OUT + "/v3b_skull_%s.png" % mont)
            R[mont] = d
            pg.close()
        b.close()
finally:
    C.cleanup()

for mont, d in R.items():
    E = np.array([e["dir"] for e in d["el"]]); E = E / np.linalg.norm(E, axis=1)[:, None]
    vals = np.array([e["shown"] for e in d["el"]])
    exact = spline_eval(E, vals, E)
    print("== montage", mont, "verts", d["nverts"], "uOpacity", d["uOpacity"])
    print("  spline at electrode itself, max |f(e)-v| =", float(np.max(np.abs(exact - vals))))
    q = np.array([v["dir"] for v in d["verts"]])
    mine = spline_eval(E, vals, q)
    page = np.array([v["aVal"] for v in d["verts"]])
    print("  page aVal vs independent spline over %d vertices: max abs diff = %.2e" % (len(q), float(np.max(np.abs(mine - page)))))
    A = Image.open(C.OUT + "/v3b_shell_%s.png" % mont).convert("RGB")
    B = Image.open(C.OUT + "/v3b_skull_%s.png" % mont).convert("RGB")
    errs = []
    for k, v in enumerate(d["verts"]):
        if v["ndv"] < 0.6 or v["mask"] < 0.5 or not (0 <= v["x"] < 1440 and 0 <= v["y"] < 900):
            continue
        x, y = int(round(v["x"])), int(round(v["y"]))
        px, bg = A.getpixel((x, y)), B.getpixel((x, y))
        if px == bg:
            continue  # occluded by nose etc.
        a = v["mask"] * d["uOpacity"]
        shade = 1 + (0.80 - 1) * (1 - v["ndv"]) ** 2
        lc = d["lut"][k]
        exp = [l2s(a * s2l(lc[c]) * shade + (1 - a) * s2l(bg[c])) for c in range(3)]
        errs.append((max(abs(exp[c] - px[c]) for c in range(3)), v["aVal"], px, [round(e) for e in exp]))
    errs.sort(key=lambda e: e[0])
    if errs:
        e_only = [e[0] for e in errs]
        print("  pixel vs expected over %d visible vertices: median err %.1f, p90 %.1f, max %.1f (0-255)" % (len(errs), e_only[len(errs) // 2], e_only[int(len(errs) * 0.9)], e_only[-1]))
        print("  worst 3:", errs[-3:])
