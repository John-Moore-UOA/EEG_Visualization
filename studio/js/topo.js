// ===== TOPOGRAPHY (per subject) =====
// A heatmap cap shrink-wrapped onto the avatar's head (radial height map), Perrin spherical-spline interpolation,
// electrodes (cup + HDR core + halo + quality ring + label), a cap net, and envelope-correlation arcs.
// Everything lives in the "head frame" group, parented to the head bone, so it follows the idle motion.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { BANDS, CONFIG, MONTAGE, montageFor, sstep, mix, easeIO, D2R, REDUCED_MOTION, montageChannels } from './config.js';
import { fitHeadFrame } from './avatar.js';

// ---------------------------------------------------------------- spline maths
function splineG(x) {
  let p0 = 1, p1 = x, sum = 0;
  for (let n = 1; n <= 40; n++) {
    const pn = n === 1 ? x : ((2 * n - 1) * x * p1 - (n - 1) * p0) / n;
    if (n > 1) { p0 = p1; p1 = pn; }
    sum += (2 * n + 1) / Math.pow(n * (n + 1), 4) * pn;
  }
  return sum / (4 * Math.PI);
}
function invert(A) {
  const n = A.length, M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12; for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; if (f) for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map(r => r.slice(n));
}
function project2D(x, y, z) { const th = Math.acos(Math.max(-1, Math.min(1, y))), h = Math.hypot(x, z) || 1; return [th * x / h, th * z / h]; }
function convexHull(pts) {
  const P = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]), cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
function hullOutside(h, p) {
  let m = -Infinity;
  for (let i = 0; i < h.length; i++) { const a = h[i], b = h[(i + 1) % h.length], ex = b[0] - a[0], ey = b[1] - a[1], L = Math.hypot(ex, ey) || 1; m = Math.max(m, ((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / L); }
  return m;
}
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

// ---------------------------------------------------------------- shared resources
const haloTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const hitMat = new THREE.MeshBasicMaterial({ visible: false });

const capVert = /* glsl */`
  attribute vec3 aDir; attribute float aVal; attribute float aMask;
  varying float vVal; varying float vMask; varying float vDirZ; varying vec3 vN; varying vec3 vV;
  void main() {
    vVal = aVal; vMask = aMask; vDirZ = aDir.z;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vV = -mv.xyz; vN = normalMatrix * normal;
    gl_Position = projectionMatrix * mv;
  }`;
const capFrag = /* glsl */`
  uniform sampler2D uLUT; uniform float uSat; uniform float uSweep; uniform float uOpacity; uniform float uIso; uniform float uDiv;
  varying float vVal; varying float vMask; varying float vDirZ; varying vec3 vN; varying vec3 vV;
  void main() {
    float a = vMask * uOpacity;
    if (a < 0.003) discard;
    float t = clamp(vVal, 0.0, 1.0);
    vec3 col = texture2D(uLUT, vec2(t * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).rgb;
    vec3 n = normalize(vN), v = normalize(vV);
    float ndv = clamp(dot(n, v), 0.0, 1.0);
    col *= mix(1.0, 0.78, pow(1.0 - ndv, 2.0));
    col *= 0.86 + 0.14 * clamp(dot(n, normalize(vec3(-0.3, 0.8, 0.5))), 0.0, 1.0);      // soft key so the cap reads as a surface
    float s = t * 10.0, w = max(fwidth(s), 1e-4), f = fract(s);
    float line = (1.0 - smoothstep(0.0, w * 1.2, min(f, 1.0 - f))) * step(0.002, t) * step(t, 0.998);
    col = mix(col, col * 0.7, line * 0.55 * uIso);
    if (uDiv > 0.5) { float z = abs(t - 0.5); a *= smoothstep(0.0, 0.06, z) * 0.85 + 0.15; }  // diverging: "no change" recedes
    if (uSweep > 0.0 && uSweep < 1.0) { float b = exp(-pow((vDirZ - mix(1.1, -1.1, uSweep)) / 0.09, 2.0)); col *= 1.0 + 0.14 * b; }
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(l), col, uSat);
    gl_FragColor = vec4(col, a);
  }`;

// ---------------------------------------------------------------- Topography
export class Topography {
  constructor(avatar, { luts, accent, labelsLayer }) {
    this.av = avatar; this.luts = luts; this.accent = new THREE.Color(accent);
    this.group = new THREE.Group(); this.group.name = 'headFrame';
    this.layers = { heatmap: true, electrodes: true, labels: true, net: true, arcs: false, quality: true };
    this.mode = 'abs';
    this.band = CONFIG.defaultBand; this.bi = BANDS.indexOf(this.band);
    this.active = []; this.staleEls = []; this.montageKey = ''; this.storeVersion = -1;
    this.disp = BANDS.map(() => new Float32Array(0)); this.shown = new Float32Array(0); this.from = new Float32Array(0);
    this.mixT = 1; this.mixStart = 0; this.sweepStart = -1;
    this.sat = 1; this.ok = true; this.hasData = false; this.dataFade = 0;
    this.introStart = performance.now(); this.hl = null;
    this.capU = { uLUT: { value: luts.seq }, uSat: { value: 1 }, uSweep: { value: 0 }, uOpacity: { value: 0 }, uIso: { value: 1 }, uDiv: { value: 0 } };
    this.capMat = new THREE.ShaderMaterial({ uniforms: this.capU, vertexShader: capVert, fragmentShader: capFrag, transparent: true, depthWrite: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.netMat = new THREE.LineBasicMaterial({ color: 0x8b95a3, transparent: true, opacity: 0.28, depthWrite: false });
    this.electrodes = [];
    this.arcs = [];
    this._aecT = 0;
  }

  // (re)build every head-frame object for a given fit
  build(fit) {
    const av = this.av;
    if (!av.headCloud) av.sampleHead();
    this.dispose();
    const F = fitHeadFrame(av, fit);
    this.F = F;
    this.group.matrixAutoUpdate = false;
    this.group.matrix.copy(F.frameToBone);
    if (this.group.parent !== av.headBone) av.headBone.add(this.group);
    const r = F.r, radii = F.radii, H = F.heights;
    this.r = r;
    const S = (u, off, out = new THREE.Vector3()) => {               // ideal sphere direction -> surface point (frame space)
      out.set(u[0] * radii.x, u[1] * radii.y, u[2] * radii.z).normalize();
      const R = H.sample(out.x, out.y, out.z);
      return out.multiplyScalar(R + off);
    };
    const N = (u, out = new THREE.Vector3()) => {                    // outward surface normal at u
      const p0 = S(u, 0), up = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const t1 = new THREE.Vector3().crossVectors(new THREE.Vector3(...up), new THREE.Vector3(...u)).normalize();
      const t2 = new THREE.Vector3().crossVectors(new THREE.Vector3(...u), t1).normalize();
      const e = 0.01, p1 = S(new THREE.Vector3(...u).addScaledVector(t1, e).normalize().toArray(), 0), p2 = S(new THREE.Vector3(...u).addScaledVector(t2, e).normalize().toArray(), 0);
      out.crossVectors(p1.sub(p0), p2.sub(p0)).normalize();
      if (out.dot(p0) < 0) out.negate();
      return out;
    };
    this.S = S; this.Nrm = N;

    // ---- cap ----
    let g = new THREE.IcosahedronGeometry(1, 44);
    g.deleteAttribute('normal'); g.deleteAttribute('uv'); g = mergeVertices(g);
    const P = g.attributes.position, I = g.index.array, n = P.count;
    const dir = new Float32Array(n * 3), smask = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let x = P.getX(i), y = P.getY(i), z = P.getZ(i); const l = Math.hypot(x, y, z); x /= l; y /= l; z /= l;
      dir[i * 3] = x; dir[i * 3 + 1] = y; dir[i * 3 + 2] = z;
      const th = Math.acos(Math.max(-1, Math.min(1, y))) / D2R;
      const edge = 1 - sstep(100, 113, th);
      const front = 1 - sstep(0.80, 0.92, z) * sstep(-0.06, -0.18, y);
      smask[i] = y >= -0.4 ? edge * front : 0;
    }
    const remap = new Int32Array(n).fill(-1), idx = [], keep = [];
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t], b = I[t + 1], c = I[t + 2];
      if (Math.max(smask[a], smask[b], smask[c]) <= 0.001) continue;
      for (const v of [a, b, c]) { if (remap[v] < 0) { remap[v] = keep.length; keep.push(v); } idx.push(remap[v]); }
    }
    const m = keep.length, pos = new Float32Array(m * 3), aDir = new Float32Array(m * 3), staticMask = new Float32Array(m), o = new THREE.Vector3();
    keep.forEach((v, i) => {
      const u = [dir[v * 3], dir[v * 3 + 1], dir[v * 3 + 2]];
      S(u, 0.0011, o); pos[i * 3] = o.x; pos[i * 3 + 1] = o.y; pos[i * 3 + 2] = o.z;
      aDir.set(u, i * 3); staticMask[i] = smask[v];
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aDir', new THREE.BufferAttribute(aDir, 3));
    geo.setAttribute('aVal', new THREE.BufferAttribute(new Float32Array(m), 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aMask', new THREE.BufferAttribute(new Float32Array(m), 1));
    geo.setIndex(idx); geo.computeVertexNormals();
    this.cap = { mesh: new THREE.Mesh(geo, this.capMat), geo, n: m, aDir, staticMask, W: new Float32Array(0), N: 0 };
    this.cap.mesh.renderOrder = 2; this.cap.mesh.frustumCulled = false;
    this.group.add(this.cap.mesh);

    // ---- electrodes (one per montage row; shown when the stream carries that channel) ----
    const k = r * 0.9;
    const cupGeo = new THREE.CylinderGeometry(0.045 * k, 0.05 * k, 0.02 * k, 28), ringGeo = new THREE.TorusGeometry(0.047 * k, 0.0045 * k, 8, 36);
    const qGeo = new THREE.TorusGeometry(0.068 * k, 0.0065 * k, 8, 40);
    const coreGeo = new THREE.SphereGeometry(0.028 * k, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), hitGeo = new THREE.SphereGeometry(0.09 * k, 8, 6);
    const cupMat = new THREE.MeshStandardMaterial({ color: 0x2b2f35, metalness: 0.65, roughness: 0.32 });
    this._geos = [cupGeo, ringGeo, qGeo, coreGeo, hitGeo, geo]; this._mats = [cupMat];
    this.electrodes = MONTAGE.map(mm => {
      const pos = S(mm.dir, 0.0012), nrm = N(mm.dir);
      const grp = new THREE.Group(); grp.position.copy(pos); grp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), nrm);
      const cup = new THREE.Mesh(cupGeo, cupMat); grp.add(cup);
      const ringMat = new THREE.MeshBasicMaterial({ color: 0x5a6270 }); this._mats.push(ringMat);
      const ring = new THREE.Mesh(ringGeo, ringMat); ring.rotation.x = Math.PI / 2; ring.position.y = 0.01 * k; grp.add(ring);
      const qMat = new THREE.MeshBasicMaterial({ color: 0xd66a5e, transparent: true, opacity: 0, toneMapped: false }); this._mats.push(qMat);
      const qRing = new THREE.Mesh(qGeo, qMat); qRing.rotation.x = Math.PI / 2; qRing.position.y = 0.004 * k; qRing.visible = false; grp.add(qRing);
      const coreMat = new THREE.MeshBasicMaterial({ toneMapped: false }); this._mats.push(coreMat);
      const core = new THREE.Mesh(coreGeo, coreMat); core.position.y = 0.006 * k; grp.add(core);
      const hit = new THREE.Mesh(hitGeo, hitMat); hit.userData.name = mm.name; hit.userData.topo = this; grp.add(hit);
      const haloMat = new THREE.SpriteMaterial({ map: haloTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }); this._mats.push(haloMat);
      const halo = new THREE.Sprite(haloMat); halo.position.copy(pos).addScaledVector(nrm, 0.03 * k); halo.renderOrder = 3;
      const el = document.createElement('div'); el.className = 'elabel'; el.textContent = mm.name;
      const wrap = document.createElement('div'); wrap.className = 'elabel-wrap'; wrap.appendChild(el);
      const label = new CSS2DObject(wrap); label.position.copy(pos).addScaledVector(nrm, 0.08 * k); label.center.set(0.5, 1);
      this.group.add(grp, halo, label);
      grp.visible = halo.visible = label.visible = false;
      return { m: mm, name: mm.name, group: grp, core, coreMat, ring, ringMat, qRing, qMat, hit, halo, haloMat, label, el, pos, nrm, rec: null, v: 0, vis: -1, phase: Math.random() * 6.28, order: 0, idx: -1,
        wpos: new THREE.Vector3(), wnrm: new THREE.Vector3() };
    });
    this.byName = new Map(this.electrodes.map(e => [e.name, e]));
    this.hitTargets = this.electrodes.map(e => e.hit);
    this.montageKey = ''; this.storeVersion = -1;
  }

  dispose() {
    if (this.cap) { this.group.remove(this.cap.mesh); }
    for (const e of this.electrodes) { this.group.remove(e.group, e.halo, e.label); e.label.element.remove(); }
    for (const a of this.arcs) { this.group.remove(a.line); a.line.geometry.dispose(); a.line.material.dispose(); }
    if (this.net) { this.group.remove(this.net); this.net.geometry.dispose(); this.net = null; }
    (this._geos || []).forEach(g => g.dispose()); (this._mats || []).forEach(m => m.dispose());
    this.electrodes = []; this.arcs = []; this.active = []; this.staleEls = [];
  }

  setLUTs(luts, accent) { this.luts = luts; this.capU.uLUT.value = this.mode === 'delta' ? luts.div : luts.seq; this.accent.set(accent); }
  setMode(mode) { this.mode = mode; this.capU.uLUT.value = mode === 'delta' ? this.luts.div : this.luts.seq; this.capU.uDiv.value = mode === 'delta' ? 1 : 0; this.from.set(this.shown); this.mixT = 0; this.mixStart = performance.now(); }
  setBand(band) {
    const bi = BANDS.indexOf(band);
    if (bi < 0 || bi === this.bi) return;
    this.from.set(this.shown); this.band = band; this.bi = bi; this.mixT = 0; this.mixStart = performance.now();
    if (!REDUCED_MOTION) this.sweepStart = performance.now();
    this._aecT = 0;
  }

  // active electrodes = incoming channels ∩ montage; stale channels leave the fit
  syncMontage(store) {
    const known = [], unknown = [], staleKnown = [];
    for (const r of store.channels()) { const mm = montageFor(r.name); if (!mm) unknown.push(r.name); else if (r.stale) staleKnown.push(mm.name); else known.push(mm.name); }
    const placeholder = known.length === 0 && staleKnown.length === 0;
    const activeNames = placeholder ? montageChannels(19) : MONTAGE.filter(mm => known.includes(mm.name)).map(mm => mm.name);
    const staleNames = MONTAGE.filter(mm => staleKnown.includes(mm.name)).map(mm => mm.name);
    const key = activeNames.join(',') + '|' + staleNames.join(',') + (placeholder ? '|ph' : '');
    this.storeVersion = store.version; this.unknown = unknown; this.placeholder = placeholder;
    const recBy = new Map(store.channels().map(r => [r.name.toLowerCase(), r]));
    if (key === this.montageKey) { for (const e of this.active.concat(this.staleEls)) e.rec = recBy.get(e.name.toLowerCase()) || null; return false; }
    const old = new Map(this.active.map((e, i) => [e.name, i])), oldDisp = this.disp, oldShown = this.shown;
    for (const e of this.electrodes) { e.group.visible = e.halo.visible = e.label.visible = false; e.idx = -1; e.vis = -1; e.stale = false; e.el.classList.remove('stale'); }
    this.active = activeNames.map((nm, i) => { const e = this.byName.get(nm); e.idx = i; e.rec = recBy.get(nm.toLowerCase()) || null; e.group.visible = e.label.visible = true; return e; });
    this.staleEls = staleNames.map(nm => { const e = this.byName.get(nm); e.stale = true; e.rec = recBy.get(nm.toLowerCase()) || null; e.group.visible = e.label.visible = true; e.halo.visible = false; e.el.classList.add('stale'); e.coreMat.color.setRGB(0.03, 0.03, 0.035); return e; });
    const Nn = this.active.length;
    this.disp = BANDS.map((_, b) => { const a = new Float32Array(Nn); this.active.forEach((e, i) => { if (old.has(e.name)) a[i] = oldDisp[b][old.get(e.name)]; }); return a; });
    this.shown = new Float32Array(Nn); this.from = new Float32Array(Nn);
    this.active.forEach((e, i) => { if (old.has(e.name)) this.shown[i] = this.from[i] = oldShown[old.get(e.name)]; });
    [...this.active].sort((a, b) => b.m.dir[2] - a.m.dir[2]).forEach((e, i) => (e.order = i));
    this.montageKey = key;
    this._buildSpline(this.active.map(e => e.m.dir));
    this._buildNet();
    this._buildArcs();
    return true;
  }
  _buildSpline(dirs) {
    const cap = this.cap, Nn = dirs.length, nv = cap.n, D = cap.aDir, mask = cap.geo.attributes.aMask.array;
    cap.N = Nn; cap.W = new Float32Array(nv * Nn);
    if (!Nn) { mask.fill(0); cap.geo.attributes.aMask.needsUpdate = true; return; }
    const A = [];
    for (let i = 0; i <= Nn; i++) { A.push([]); for (let j = 0; j <= Nn; j++) {
      if (i === Nn && j === Nn) A[i].push(0); else if (i === Nn || j === Nn) A[i].push(1);
      else A[i].push(splineG(dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1] + dirs[i][2] * dirs[j][2]) + (i === j ? CONFIG.splineLambda : 0));
    } }
    const Ai = invert(A), G = new Float64Array(Nn);
    const hull = Nn >= 3 ? convexHull(dirs.map(d => project2D(d[0], d[1], d[2]))) : null;
    for (let v = 0; v < nv; v++) {
      let dmin = 9;
      for (let j = 0; j < Nn; j++) { const c = Math.max(-1, Math.min(1, dirs[j][0] * D[v * 3] + dirs[j][1] * D[v * 3 + 1] + dirs[j][2] * D[v * 3 + 2])); G[j] = splineG(c); dmin = Math.min(dmin, Math.acos(c)); }
      for (let kk = 0; kk < Nn; kk++) { let s = Ai[Nn][kk]; for (let j = 0; j < Nn; j++) s += G[j] * Ai[j][kk]; cap.W[v * Nn + kk] = s; }
      let cover = 1 - sstep(0.75, 1.05, dmin);
      if (hull) { const p = project2D(D[v * 3], D[v * 3 + 1], D[v * 3 + 2]); cover *= 1 - sstep(-0.05, 0.42, hullOutside(hull, p)); }
      mask[v] = 0.93 * cap.staticMask[v] * cover;
    }
    cap.geo.attributes.aMask.needsUpdate = true;
  }
  // geodesic cap net between neighbouring electrodes, conformed to the surface
  _buildNet() {
    if (this.net) { this.group.remove(this.net); this.net.geometry.dispose(); this.net = null; }
    const els = this.active.concat(this.staleEls);
    if (els.length < 3) return;
    const pairs = new Set(), pts = [], v = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
    for (const e of els) {
      const ds = els.filter(o => o !== e).map(o => ({ o, d: angle(e.m.dir, o.m.dir) })).sort((x, y) => x.d - y.d);
      const nn = ds[0].d;
      for (const { o, d } of ds) if (d <= nn * 1.3 + 0.02) { const key = [e.name, o.name].sort().join('-'); pairs.add(key); }
    }
    for (const key of pairs) {
      const [n1, n2] = key.split('-'), e1 = this.byName.get(n1), e2 = this.byName.get(n2);
      a.fromArray(e1.m.dir); b.fromArray(e2.m.dir);
      const om = a.angleTo(b), steps = Math.max(6, Math.ceil(om / 0.04));
      let prev = null;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps, sa = Math.sin((1 - t) * om) / Math.sin(om), sb = Math.sin(t * om) / Math.sin(om);
        const u = [a.x * sa + b.x * sb, a.y * sa + b.y * sb, a.z * sa + b.z * sb];
        const p = this.S(u, 0.0016, new THREE.Vector3());
        if (prev) pts.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
        prev = p;
      }
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.net = new THREE.LineSegments(geo, this.netMat); this.net.renderOrder = 3; this.net.frustumCulled = false;
    this.group.add(this.net);
  }
  // one Line2 per electrode pair: a lifted great-circle arc; strength drives width/opacity/flow
  _buildArcs() {
    for (const a of this.arcs) { this.group.remove(a.line); a.line.geometry.dispose(); a.line.material.dispose(); }
    this.arcs = [];
    const els = this.active;
    for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
      const e1 = els[i], e2 = els[j], a = new THREE.Vector3(...e1.m.dir), b = new THREE.Vector3(...e2.m.dir);
      const om = a.angleTo(b); if (om < 0.25) continue;
      const p0 = e1.pos, p3 = e2.pos, chord = p0.distanceTo(p3), h = 0.42 * chord + 0.008;
      const p1 = p0.clone().addScaledVector(e1.nrm, h), p2 = p3.clone().addScaledVector(e2.nrm, h);
      const pts = [], steps = 32, q = new THREE.Vector3(), H = this.F.heights;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps, u = 1 - t;
        q.set(0, 0, 0).addScaledVector(p0, u * u * u).addScaledVector(p1, 3 * u * u * t).addScaledVector(p2, 3 * u * t * t).addScaledVector(p3, t * t * t);
        const R = H.sample(q.x, q.y, q.z) + 0.002 + this.r * 0.22 * Math.sin(Math.PI * t), L = q.length();
        if (L < R) q.multiplyScalar(R / L);
        pts.push(q.x, q.y, q.z);
      }
      const geo = new LineGeometry(); geo.setPositions(pts);
      const mat = new LineMaterial({ color: this.accent.clone(), linewidth: 2, transparent: true, opacity: 0, depthWrite: false, dashed: true, dashSize: 0.03, gapSize: 0.006, blending: THREE.AdditiveBlending, toneMapped: false });
      const line = new Line2(geo, mat); line.computeLineDistances(); line.visible = false; line.renderOrder = 4; line.frustumCulled = false;
      this.group.add(line);
      this.arcs.push({ line, mat, i, j, a: e1.name, b: e2.name, s: 0, target: 0 });
    }
  }

  // ---------------------------------------------------------------- per frame
  update(dt, now, { store, analytics, status, camera, arcThreshold = 0.5, labelsFit = true, maxArcs = 14 }) {
    if (!this.cap) return;
    if (store.version !== this.storeVersion) this.syncMontage(store);
    const Nn = this.active.length, k = 1 - Math.exp(-dt / CONFIG.smoothTau), delta = this.mode === 'delta' && analytics.baseline.state === 'ready';
    for (let b = 0; b < 5; b++) {
      const d = this.disp[b];
      for (let i = 0; i < Nn; i++) { const r = this.active[i].rec; const tgt = r && r.has[b] ? (delta ? r.dnorm[b] : r.norm[b]) : (delta ? 0.5 : 0); d[i] += (tgt - d[i]) * k; }
    }
    if (this.mixT < 1) this.mixT = Math.min(1, (now - this.mixStart) / CONFIG.bandMixMs);
    const e = easeIO(this.mixT), cur = this.disp[this.bi];
    for (let i = 0; i < Nn; i++) this.shown[i] = this.mixT >= 1 ? cur[i] : this.from[i] + (cur[i] - this.from[i]) * e;
    this.hasData = store.hasBand(this.band) && !this.placeholder;
    this.ok = status === 'mock' || status === 'live';
    this.sat += ((this.ok ? 1 : 0.35) - this.sat) * (1 - Math.exp(-dt / 0.2));
    this.dataFade += ((this.hasData ? 1 : 0) - this.dataFade) * (1 - Math.exp(-dt / 0.25));

    // cap
    const cap = this.cap, W = cap.W, val = cap.geo.attributes.aVal.array, s = this.shown;
    if (cap.N && cap.N === Nn) {
      for (let v = 0, o = 0; v < cap.n; v++, o += Nn) { let acc = 0; for (let kk = 0; kk < Nn; kk++) acc += W[o + kk] * s[kk]; val[v] = acc; }
      cap.geo.attributes.aVal.needsUpdate = true;
    }
    const intro = REDUCED_MOTION ? 1 : sstep(300, 1300, now - this.introStart);
    this.capU.uOpacity.value = intro * this.dataFade * (this.layers.heatmap ? 1 : 0);
    cap.mesh.visible = this.capU.uOpacity.value > 0.003;
    this.capU.uSat.value = this.sat;
    this.capU.uSweep.value = this.sweepStart < 0 ? 0 : Math.min(1, (now - this.sweepStart) / 700);
    if (this.capU.uSweep.value >= 1) { this.sweepStart = -1; this.capU.uSweep.value = 0; }
    if (this.net) { this.net.visible = this.layers.net; this.netMat.opacity = 0.22 * intro; }

    // electrodes
    this.group.updateWorldMatrix(true, false);
    const gq = _q.setFromRotationMatrix(this.group.matrixWorld), camPos = camera.position, t = now / 1000;
    const showEl = this.layers.electrodes, showLab = this.layers.labels && labelsFit;
    for (const el of this.active) {
      el.wpos.copy(el.pos).applyMatrix4(this.group.matrixWorld); el.wnrm.copy(el.nrm).applyQuaternion(gq);
      const introOn = REDUCED_MOTION ? 1 : sstep(0, 260, now - this.introStart - 500 - el.order * 28);
      const v = this.hasData ? this.shown[el.idx] : 0;
      const lut = delta ? this.luts.divMap : this.luts.seqMap;
      lut.sample(v, _c);
      const mag = delta ? Math.abs(v - 0.5) * 2 : v;
      let kH = this.hasData ? 1.0 + 2.2 * Math.pow(mag, 1.6) : 0.35;
      if (!this.ok) kH = Math.min(kH, 1.0); else if (!REDUCED_MOTION) kH *= 1 + 0.03 * Math.sin(t * 1.9 + el.phase);
      kH *= mix(0.25, 1, introOn);
      _v.copy(camPos).sub(el.wpos).normalize();
      const facing = _v.dot(el.wnrm);
      kH = mix(Math.min(kH, 0.35), kH, sstep(0.12, 0.4, facing));
      _col.setRGB(_c[0], _c[1], _c[2], THREE.SRGBColorSpace);
      const l = 0.2126 * _col.r + 0.7152 * _col.g + 0.0722 * _col.b;
      _col.setRGB(mix(l, _col.r, this.sat), mix(l, _col.g, this.sat), mix(l, _col.b, this.sat), THREE.LinearSRGBColorSpace);
      el.coreMat.color.copy(_col).multiplyScalar(kH);
      el.core.scale.setScalar((0.85 + 0.35 * mag) * mix(0.6, 1, introOn));
      el.haloMat.color.copy(_col);
      el.haloMat.opacity = showEl && this.hasData ? (0.10 + 0.45 * mag) * introOn * (this.ok ? 1 : 0.4) * sstep(0.12, 0.4, facing) : 0;
      el.halo.visible = el.haloMat.opacity > 0.004;
      const hs = (0.10 + 0.14 * mag) * this.r * 0.9; el.halo.scale.set(hs, hs, 1);
      el.group.visible = showEl;
      const isHl = this.hl === el.name;
      el.ringMat.color.setHex(isHl ? 0xe8e6e1 : 0x5a6270);
      // quality ring
      const q = el.rec ? el.rec.quality : 1, bad = this.layers.quality && q < 0.75;
      el.qRing.visible = bad && showEl;
      if (bad) { el.qMat.color.setHex(q < 0.45 ? 0xe0675a : 0xe0a24a); el.qMat.opacity = 0.55 + 0.35 * Math.sin(t * 5 + el.phase) ** 2; }
      el.el.classList.toggle('poor', bad);
      const vis = showLab && (facing > 0.08 || isHl) ? 1 : 0;
      el.label.visible = showLab;
      if (vis !== el.vis) { el.vis = vis; el.el.style.opacity = vis; }
      if (isHl !== el._hl) { el._hl = isHl; el.el.classList.toggle('hl', isHl); }
    }
    for (const el of this.staleEls) {
      el.wpos.copy(el.pos).applyMatrix4(this.group.matrixWorld); el.wnrm.copy(el.nrm).applyQuaternion(gq);
      _v.copy(camPos).sub(el.wpos).normalize();
      const vis = showLab && (_v.dot(el.wnrm) > 0.08 || this.hl === el.name) ? 1 : 0;
      if (vis !== el.vis) { el.vis = vis; el.el.style.opacity = vis; }
      el.group.visible = showEl; el.qRing.visible = false;
    }

    // arcs (envelope correlation)
    const arcsOn = this.layers.arcs && this.hasData;
    if (arcsOn && now - this._aecT > 400) {
      this._aecT = now;
      const A = analytics.computeAEC(this.bi), idx = new Map(A.names.map((nm, i) => [nm, i])), NA = A.names.length;
      for (const a of this.arcs) { const i = idx.get(a.a), j = idx.get(a.b); a.target = i === undefined || j === undefined ? 0 : A.R[i * NA + j]; }
      // only the strongest links are drawn: a legible network, never a hairball
      const ranked = this.arcs.filter(a => a.target >= arcThreshold).sort((x, y) => y.target - x.target);
      for (const a of this.arcs) a.top = false;
      for (let q = 0; q < Math.min(maxArcs, ranked.length); q++) ranked[q].top = true;
    }
    for (const a of this.arcs) {
      const tgt = arcsOn && a.top ? 0.25 + 0.75 * sstep(arcThreshold, Math.min(1, arcThreshold + 0.3), a.target) : 0;
      a.s += (tgt - a.s) * (1 - Math.exp(-dt / 0.35));
      const vis = a.s > 0.01;
      a.line.visible = vis;
      if (!vis) continue;
      a.mat.opacity = (0.35 + 0.65 * a.s) * Math.min(1, a.s * 4) * this.sat;
      a.mat.linewidth = 0.8 + 1.8 * a.s;
      a.mat.color.copy(this.accent).multiplyScalar(0.75 + 0.9 * a.s);
      a.mat.dashOffset -= dt * (0.015 + 0.04 * a.s);
    }
  }
  strongestLinks(n = 5) { return this.arcs.filter(a => a.target > 0).sort((x, y) => y.target - x.target).slice(0, n); }
  density(th) { if (!this.arcs.length) return 0; return this.arcs.filter(a => a.target >= th).length / this.arcs.length; }
}
const _c = [0, 0, 0], _col = new THREE.Color(), _v = new THREE.Vector3(), _q = new THREE.Quaternion();
