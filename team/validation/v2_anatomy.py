"""V2: electrode world positions, handedness, symmetry, surface distance, projections in named views."""
import json
from playwright.sync_api import sync_playwright
import common as C

C.http()
JS = """
async () => {
  const THREE = await import('three');
  const V = __eeg.VIEW;
  // find the scene: walk from an electrode group to the root
  const e0 = V.active[0]; let root = e0.group; while (root.parent) root = root.parent;
  const head = root.children.find(o => o.isGroup && o.children.some(c => c.isMesh && c.geometry.type !== 'CylinderGeometry'));
  const out = {};
  // electrodes in VIEW.active: world position
  for (const e of V.active) {
    const p = new THREE.Vector3(); e.group.getWorldPosition(p);
    out[e.name] = {pos: [p.x, p.y, p.z].map(v => +v.toFixed(4)), dir: e.m.dir.map(v => +v.toFixed(4)), nrm: [e.nrm.x, e.nrm.y, e.nrm.z].map(v => +v.toFixed(3))};
  }
  // distance from electrode to head mesh surface along -normal (raycast)
  const headMesh = head.children[0];
  const rc = new THREE.Raycaster();
  for (const e of V.active) {
    const p = new THREE.Vector3(); e.group.getWorldPosition(p);
    const o = p.clone().addScaledVector(e.nrm, 0.5); rc.set(o, e.nrm.clone().negate());
    const h = rc.intersectObject(headMesh, false);
    out[e.name].surfDist = h.length ? +(h[0].distance - 0.5).toFixed(4) : null;
  }
  // L/R markers
  const marks = [];
  root.traverse(o => { if (o.isCSS2DObject && o.element.classList.contains('axislabel')) marks.push({t: o.element.textContent, x: o.position.x}); });
  // check for any negative scale / mirroring in the hierarchy
  let mirrored = false; root.traverse(o => { if (o.scale.x * o.scale.y * o.scale.z < 0) mirrored = true; });
  const mesh = headMesh; mesh.geometry.computeBoundingBox(); const bb = mesh.geometry.boundingBox;
  return {el: out, marks, mirrored, bbox: {min: bb.min.toArray().map(v=>+v.toFixed(3)), max: bb.max.toArray().map(v=>+v.toFixed(3))}};
}
"""
PROJ = """
async (view) => {
  __eeg.goView(view);
  await new Promise(r => setTimeout(r, 1300));
  const THREE = await import('three');
  const V = __eeg.VIEW; let cam = null;
  // camera from the renderer's last render isn't exposed; rebuild from label DOM positions instead
  const res = {};
  for (const e of V.active) {
    const r = e.el.getBoundingClientRect();
    res[e.name] = {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), vis: e.el.style.opacity};
  }
  for (const m of document.querySelectorAll('.axislabel')) { const r = m.getBoundingClientRect(); res['marker_' + m.textContent] = {x: Math.round(r.left), y: Math.round(r.top), vis: m.style.opacity}; }
  return res;
}
"""
res = {}
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=C.GPU_ARGS)
        for mont in ["10", "19"]:
            pg = b.new_page(viewport={"width": 1440, "height": 900})
            pg.goto(C.BASE + "?degrade=0&montage=" + mont); pg.wait_for_timeout(2500)
            res["world_" + mont] = pg.evaluate(JS)
            if mont == "10":
                for v in ["front", "top", "back", "left", "right", "home"]:
                    res["proj_" + v] = pg.evaluate(PROJ, v)
                    pg.screenshot(path=C.OUT + "/v2_view_" + v + ".png")
            pg.close()
        b.close()
finally:
    C.cleanup()
json.dump(res, open(C.OUT + "/v2_anatomy.json", "w"), indent=1)

w = res["world_19"]["el"]
print("mirrored flag:", res["world_19"]["mirrored"], "markers:", res["world_19"]["marks"], "bbox", res["world_19"]["bbox"])
for n, d in w.items():
    print("%-4s pos=%s dir=%s surf=%s" % (n, d["pos"], d["dir"], d["surfDist"]))
# symmetry
pairs = [("Fp1", "Fp2"), ("F3", "F4"), ("C3", "C4"), ("P3", "P4"), ("O1", "O2"), ("F7", "F8"), ("T7", "T8"), ("P7", "P8")]
for a, c in pairs:
    pa, pc = w[a]["pos"], w[c]["pos"]
    print("sym %s/%s: dx_sum=%.4f dy=%.4f dz=%.4f" % (a, c, pa[0] + pc[0], pa[1] - pc[1], pa[2] - pc[2]))
for v in ["front", "top", "back", "left", "right", "home"]:
    pr = res["proj_" + v]
    print(v, {k: (val["x"], val["y"], val["vis"]) for k, val in pr.items()})
