"""V5: acceptance checks that need a live browser (perf, UI/a11y, motion, label occlusion, coverage mask, mock events)."""
import json
import math
import sys
from playwright.sync_api import sync_playwright
import common as C

HOOK = r"""
() => { const r = __eeg.renderer, o = r.render; window.__mainInfo = null;
  r.render = function (s, c) { const res = o.call(this, s, c); if (c && c.isPerspectiveCamera) { window.__cam = c; window.__scene = s;
    window.__mainInfo = {calls: r.info.render.calls, triangles: r.info.render.triangles, lines: r.info.render.lines, points: r.info.render.points}; } return res; };
  return true; }
"""
FPS = r"""async (ms) => { let n = 0, worst = 0, last = performance.now(); const t0 = last;
  await new Promise(res => { const f = () => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; n++; if (now - t0 < ms) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
  return {fps: n * 1000 / (performance.now() - t0), worstFrameMs: worst}; }"""
AZ = "() => { const c = window.__cam.position; return Math.atan2(c.x, c.z) * 180 / Math.PI; }"
OCCL = r"""async () => {
  const THREE = await import('three'); const cam = window.__cam; let head = null;
  window.__scene.traverse(o => { if (!head && o.isMesh && o.material.isMeshStandardMaterial && o.geometry.attributes.position.count > 3000) head = o; });
  const rc = new THREE.Raycaster(); const bad = []; let checked = 0;
  for (const view of [[64,-68],[80,0],[80,90],[80,180],[80,-90],[30,45],[110,-30],[100,135],[20,-120],[90,-150],[60,150],[100,60]]) {
    const s = new THREE.Spherical(cam.position.distanceTo(new THREE.Vector3(0,-0.15,0)), view[0]*Math.PI/180, view[1]*Math.PI/180);
    cam.position.setFromSpherical(s).add(new THREE.Vector3(0,-0.15,0)); cam.lookAt(0,-0.15,0); cam.updateMatrixWorld();
    await new Promise(r => setTimeout(r, 120));
    for (const e of __eeg.VIEW.active) {
      const target = e.labelPos.clone(); const dir = target.clone().sub(cam.position); const dist = dir.length(); dir.normalize();
      rc.set(cam.position, dir); const h = rc.intersectObject(head, false);
      const hidden = h.length && h[0].distance < dist - 0.02; checked++;
      const op = +getComputedStyle(e.el).opacity, styleOp = e.el.style.opacity;
      if (hidden && styleOp === '1') bad.push({view, name: e.name, styleOp, hitAt: +h[0].distance.toFixed(3), labelAt: +dist.toFixed(3)});
    }
  }
  return {checked, bad};
}"""

C.http()
R = {}
L = C.Log()
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=C.GPU_ARGS)
        ctx = b.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        pg = ctx.new_page(); L.attach(pg, "main")
        pg.goto(C.BASE); pg.wait_for_timeout(3000)
        pg.evaluate(HOOK); pg.wait_for_timeout(200)
        # P1 perf (default quality, auto-degrade ON, DPR 1 at this context)
        R["fps_10s"] = pg.evaluate(FPS, 10000)
        R["main_pass_info"] = pg.evaluate("() => window.__mainInfo")
        R["bloom_enabled_after_10s"] = pg.evaluate("() => __eeg.renderer && true")
        # M1 auto-rotate speed (idle since load)
        a0 = pg.evaluate(AZ); pg.wait_for_timeout(5000); a1 = pg.evaluate(AZ)
        R["autorotate_deg_per_s"] = ((a1 - a0 + 540) % 360 - 180) / 5.0
        # stop on interaction (drag) and resume after ~8 s with ramp
        pg.mouse.move(720, 450); pg.mouse.down(); pg.mouse.move(760, 455, steps=5); pg.mouse.up()
        samples = []
        prev = pg.evaluate(AZ)
        for i in range(24):
            pg.wait_for_timeout(500)
            cur = pg.evaluate(AZ); samples.append(round(((cur - prev + 540) % 360 - 180) / 0.5, 2)); prev = cur
        R["az_rate_after_drag_every_0.5s"] = samples
        # U6 label occlusion over 12 views
        R["label_occlusion"] = pg.evaluate(OCCL)
        pg.evaluate("() => __eeg.goView('home')"); pg.wait_for_timeout(1500)
        # U1 select styling + keys 1-5
        R["select_style"] = pg.evaluate("() => { const s = getComputedStyle(document.getElementById('band')); return {appearance: s.appearance, bg: s.backgroundColor, h: s.height, label: !!document.querySelector('label[for=band]')}; }")
        keys = {}
        pg.mouse.click(700, 120)
        for k in "12345":
            pg.keyboard.press(k); pg.wait_for_timeout(150); keys[k] = pg.evaluate("() => document.getElementById('band').value")
        R["keys"] = keys
        pg.keyboard.press("3"); pg.wait_for_timeout(800)
        # M2 crossfade timing
        pg.evaluate("() => { window.__mix = []; const t0 = performance.now(); const f = () => { window.__mix.push([performance.now() - t0, __eeg.VIEW.mixT]); if (performance.now() - t0 < 1200) requestAnimationFrame(f); }; __eeg.setBand('beta'); requestAnimationFrame(f); }")
        pg.wait_for_timeout(1400)
        mix = pg.evaluate("() => window.__mix")
        done = [m[0] for m in mix if m[1] >= 1]
        R["crossfade_ms"] = round(done[0]) if done else None
        # re-switch mid transition: max per-frame jump in shown
        R["reswitch_max_jump"] = pg.evaluate(r"""async () => { __eeg.setBand('delta'); await new Promise(r => setTimeout(r, 250)); let prev = Array.from(__eeg.VIEW.shown), maxJ = 0;
          __eeg.setBand('gamma'); const t0 = performance.now();
          await new Promise(res => { const f = () => { const cur = Array.from(__eeg.VIEW.shown); for (let i = 0; i < cur.length; i++) maxJ = Math.max(maxJ, Math.abs(cur[i] - prev[i])); prev = cur; if (performance.now() - t0 < 800) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
          return maxJ; }""")
        pg.keyboard.press("3"); pg.wait_for_timeout(900)
        # U4 fps readout update rate
        R["fps_text_updates_per_s"] = pg.evaluate(r"""async () => { let n = 0; const el = document.getElementById('fps'); const mo = new MutationObserver(() => n++); mo.observe(el, {childList: true, characterData: true, subtree: true});
          await new Promise(r => setTimeout(r, 5000)); mo.disconnect(); return n / 5; }""")
        # U5 hover electrode -> tooltip + row highlight; row hover -> ring white; Esc unpins
        pg.evaluate("() => __eeg.goView('back')"); pg.wait_for_timeout(1500)
        pos = pg.evaluate("() => { const e = __eeg.VIEW.active.find(x => x.name === 'O1'); const v = e.pos.clone().project(window.__cam); return [(v.x + 1) / 2 * innerWidth, (1 - v.y) / 2 * innerHeight]; }")
        pg.mouse.move(pos[0] + 3, pos[1] + 3); pg.wait_for_timeout(120); pg.mouse.move(pos[0], pos[1]); pg.wait_for_timeout(600)
        R["hover_O1"] = pg.evaluate(r"""() => { const t = document.getElementById('tooltip'); return {hover: __eeg.VIEW.hover, tooltipVisible: !t.hidden, text: t.innerText.split(String.fromCharCode(10)).join(' | '),
          sparkHasInk: (() => { const c = document.getElementById('ttSpark'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let k = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) k++; return k; })(),
          rowHl: document.querySelector('button.ch[data-name=O1]').classList.contains('hl'), marker: document.getElementById('legendMarker').style.opacity}; }""")
        pg.mouse.move(1300, 850); pg.wait_for_timeout(300)
        pg.hover("button.ch[data-name=C4]"); pg.wait_for_timeout(300)
        R["row_hover_C4"] = pg.evaluate("() => { const e = __eeg.VIEW.active.find(x => x.name === 'C4'); return {ring: e.ringMat.color.getHexString(), labelHl: e.el.classList.contains('hl')}; }")
        pg.click("button.ch[data-name=C4]"); pg.wait_for_timeout(200)
        p1 = pg.evaluate("() => __eeg.VIEW.pinned"); pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
        R["pin_then_esc"] = [p1, pg.evaluate("() => __eeg.VIEW.pinned")]
        # U3 aria-live
        R["aria_live"] = pg.evaluate("() => { const s = document.getElementById('srStatus'); return {live: s.getAttribute('aria-live'), text: s.textContent}; }")
        # U7 tab order
        pg.evaluate("() => document.activeElement && document.activeElement.blur()")
        order = []
        pg.mouse.click(5, 450)
        for i in range(22):
            pg.keyboard.press("Tab")
            order.append(pg.evaluate("() => { const a = document.activeElement; const r = a.getBoundingClientRect(); const o = getComputedStyle(a).outlineStyle + ' ' + getComputedStyle(a).outlineWidth; const lab = a.id || a.dataset.view || a.dataset.name || a.tagName; let ring = o; if (a.matches('.seg input')) { const l = a.nextElementSibling; ring = 'label:' + getComputedStyle(l).outlineStyle + ' ' + getComputedStyle(l).outlineWidth; } return lab + ' [' + ring + ']'; }"))
        R["tab_order"] = order
        # U2: min font size of visible text
        R["min_font_px"] = pg.evaluate(r"""() => { let min = 99, who = ''; for (const el of document.querySelectorAll('body *')) { if (!el.childNodes.length) continue; let hasText = false; for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) hasText = true; if (!hasText) continue; const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') continue; const fs = parseFloat(cs.fontSize); if (fs < min) { min = fs; who = el.className || el.tagName; } } return {min, who}; }""")
        # A8 ticks alignment
        R["ticks_align"] = pg.evaluate(r"""() => { const bar = document.getElementById('legendBar').getBoundingClientRect(); const t = [...document.querySelectorAll('#ticks span')].map(s => s.getBoundingClientRect());
          return {n: t.length, firstLeftVsBar: +(t[0].left - bar.left).toFixed(1), lastRightVsBar: +(t[t.length - 1].right - bar.right).toFixed(1), texts: [...document.querySelectorAll('#ticks span')].map(s => s.textContent)}; }""")
        # A5/A6 mask checks
        R["mask"] = pg.evaluate(r"""() => { let shell = null; window.__scene.traverse(o => { if (o.isMesh && o.material.isShaderMaterial) shell = o; });
          const D = shell.geometry.attributes.aDir.array, M = shell.geometry.attributes.aMask.array; let maxBelow = 0, maxFace = 0, maxEar = 0;
          const near = (i, x, y, z) => { const n = Math.hypot(x, y, z); return (D[i*3]*x + D[i*3+1]*y + D[i*3+2]*z) / n; };
          for (let i = 0; i < M.length; i++) { const th = Math.acos(D[i*3+1]) * 180 / Math.PI; if (th > 115) maxBelow = Math.max(maxBelow, M[i]);
            if (near(i, 0.33, -0.44, 0.84) > Math.cos(0.2) || near(i, -0.33, -0.44, 0.84) > Math.cos(0.2) || near(i, 0, -0.45, 0.89) > Math.cos(0.15)) maxFace = Math.max(maxFace, M[i]);
            if (near(i, 0.83, -0.40, -0.08) > Math.cos(0.15) || near(i, -0.83, -0.40, -0.08) > Math.cos(0.15)) maxEar = Math.max(maxEar, M[i]); }
          const at = (x, y, z) => { let best = -2, bi = 0; for (let i = 0; i < M.length; i++) { const c = near(i, x, y, z); if (c > best) { best = c; bi = i; } } return +M[bi].toFixed(3); };
          return {maxMaskBelow115: maxBelow, maxMaskEyesNose: maxFace, maxMaskEars: maxEar, T7: at(-1, -0.035, 0), Cz: at(0, 1, 0), O1: at(-0.309, -0.035, -0.95), coverKeyHidden: document.getElementById('coverKey').hidden}; }""")
        # ear rotation actually applied?
        R["ear_rotation"] = pg.evaluate(r"""() => { const r = []; window.__scene.traverse(o => { if (o.isMesh && o.geometry.type === 'SphereGeometry' && o.geometry.parameters.radius === 1) r.push([o.rotation.x, o.rotation.y, o.rotation.z]); }); return r; }""")
        ctx.close()

        # 19 ch mask
        pg = b.new_page(viewport={"width": 1440, "height": 900}); pg.goto(C.BASE + "?montage=19"); pg.wait_for_timeout(2500); pg.evaluate(HOOK); pg.wait_for_timeout(100)
        R["mask19"] = pg.evaluate(r"""() => { let shell = null; window.__scene.traverse(o => { if (o.isMesh && o.material.isShaderMaterial) shell = o; }); const D = shell.geometry.attributes.aDir.array, M = shell.geometry.attributes.aMask.array;
          const at = (x, y, z) => { let best = -2, bi = 0; for (let i = 0; i < M.length; i++) { const c = D[i*3]*x + D[i*3+1]*y + D[i*3+2]*z; if (c > best) { best = c; bi = i; } } return +M[bi].toFixed(3); };
          return {T7: at(-0.999, -0.035, 0), Cz: at(0, 1, 0), coverKeyHidden: document.getElementById('coverKey').hidden, info: window.__mainInfo}; }""")
        pg.wait_for_timeout(300)
        R["main_pass_info_19"] = pg.evaluate("() => window.__mainInfo")
        pg.close()

        # M3 reduced motion
        ctx = b.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
        pg = ctx.new_page(); L.attach(pg, "reduced")
        pg.goto(C.BASE); pg.wait_for_timeout(300); pg.evaluate(HOOK); pg.wait_for_timeout(200)
        R["rm_intro_opacity_at_0.5s"] = pg.evaluate("() => { let s = null; window.__scene.traverse(o => { if (o.isMesh && o.material.isShaderMaterial) s = o; }); return s.material.uniforms.uOpacity.value; }")
        a0 = pg.evaluate(AZ); pg.wait_for_timeout(10000); a1 = pg.evaluate(AZ)
        R["rm_az_change_10s"] = a1 - a0
        pg.evaluate("() => __eeg.source.stop()"); pg.wait_for_timeout(1500)
        R["rm_shimmer"] = pg.evaluate(r"""async () => { const e = __eeg.VIEW.active[0]; const v = []; for (let i = 0; i < 10; i++) { v.push(e.coreMat.color.r); await new Promise(r => setTimeout(r, 300)); } return Math.max(...v) - Math.min(...v); }""")
        R["rm_sweep"] = pg.evaluate(r"""async () => { let s = null; window.__scene.traverse(o => { if (o.isMesh && o.material.isShaderMaterial) s = o; }); __eeg.setBand('beta'); let mx = 0; for (let i = 0; i < 20; i++) { mx = Math.max(mx, s.material.uniforms.uSweep.value); await new Promise(r => setTimeout(r, 30)); } return mx; }""")
        ctx.close()

        # U8 phone with touch
        ctx = b.new_context(viewport={"width": 375, "height": 812}, is_mobile=True, has_touch=True, device_scale_factor=3)
        pg = ctx.new_page(); L.attach(pg, "phone")
        pg.goto(C.BASE); pg.wait_for_timeout(3500); pg.evaluate(HOOK); pg.wait_for_timeout(200)
        R["phone"] = pg.evaluate(r"""() => { const small = []; for (const el of document.querySelectorAll('button, select, input, label[for]')) { const r = el.getBoundingClientRect(); if (!r.width || getComputedStyle(el).visibility === 'hidden') continue; let tgt = el; if (el.matches('.seg input')) continue; if (r.height < 44 || r.width < 44) small.push((el.id || el.dataset.view || el.textContent.trim().slice(0, 12) || el.tagName) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
          const ctr = document.getElementById('controls').getBoundingClientRect(), lg = document.getElementById('legend').getBoundingClientRect();
          return {hscroll: document.documentElement.scrollWidth > innerWidth, small, controls: [ctr.top, ctr.bottom], legend: [lg.top, lg.bottom], dpr: __eeg.renderer.getPixelRatio()}; }""")
        R["phone_head_bbox"] = pg.evaluate(r"""async () => { const THREE = await import('three'); let head = null; window.__scene.traverse(o => { if (!head && o.isMesh && o.material.isMeshStandardMaterial && o.geometry.attributes.position.count > 3000) head = o; });
          const P = head.geometry.attributes.position, v = new THREE.Vector3(); let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
          for (let i = 0; i < P.count; i += 3) { v.fromBufferAttribute(P, i).project(window.__cam); const x = (v.x + 1) / 2 * innerWidth, y = (1 - v.y) / 2 * innerHeight; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
          return [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)]; }""")
        pg.screenshot(path=C.OUT + "/v5_phone.png")
        ctx.close()

        # P3 auto-degrade under forced load
        ctx = b.new_context(viewport={"width": 1440, "height": 900})
        pg = ctx.new_page(); L.attach(pg, "degrade")
        pg.goto(C.BASE); pg.wait_for_timeout(2000)
        pg.evaluate("() => { const f = () => { const t = performance.now(); while (performance.now() - t < 30) {} requestAnimationFrame(f); }; requestAnimationFrame(f); }")
        pg.wait_for_timeout(13000)
        R["degrade"] = pg.evaluate("() => ({fps: document.getElementById('fps').textContent, dpr: __eeg.renderer.getPixelRatio()})")
        ctx.close()

        # D3 mock alpha bursts over 45 s
        pg = b.new_page(viewport={"width": 800, "height": 600})
        pg.goto(C.BASE); pg.wait_for_timeout(500)
        R["mock_O1_alpha"] = pg.evaluate(r"""async () => { const out = []; for (let i = 0; i < 90; i++) { out.push(+__eeg.store.raw('alpha', 'O1').toFixed(1)); await new Promise(r => setTimeout(r, 500)); } return out; }""")
        R["mock_alpha_means"] = pg.evaluate("() => { const o = {}; for (const r of __eeg.store.channels()) { const h = __eeg.store.history('alpha', r.name); o[r.name] = +(h.reduce((a, b) => a + b, 0) / h.length).toFixed(1); } return o; }")
        b.close()
finally:
    C.cleanup()
json.dump(R, open(C.OUT + "/v5_accept.json", "w", encoding="utf-8"), indent=1, ensure_ascii=False)
for k, v in R.items():
    print(k, json.dumps(v, ensure_ascii=True)[:1200])
print("---- console ----")
for it in L.items:
    print(it[:3])
