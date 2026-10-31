// ===== EEG AVATAR STUDIO: orchestration =====
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { CONFIG, PARAMS, BANDS, BAND_INFO, THEMES, THEME_KEYS, makeMap, REDUCED_MOTION, clamp, sstep, easeIO, D2R } from './config.js';
import { createSource, SharedDrive, SIM_LABEL } from './data.js';
import { BandPowerStore, Analytics, METRICS, METRIC_KEYS, interBrainSync, spectrumFromBands, Ring } from './store.js';
import { loadModel, Avatar, FINISHES } from './avatar.js';
import { Topography } from './topo.js';
import { buildStage, buildLights, Aura, BrainBridge } from './fx.js';
import { Sonifier } from './audio.js';
import { sparkline, drawSpectrum, Spectrogram, traceChart, cssVar } from './charts.js';

const $ = id => document.getElementById(id);

// ------------------------------------------------------------------ state (+ per-viewer persistence)
const LS_KEY = 'eeg-avatar-studio-v1';
const saved = (() => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch { return {}; } })();
const S = {
  mode: ['topo', 'network', 'feedback', 'duo'].includes(PARAMS.get('mode')) ? PARAMS.get('mode') : 'topo',
  band: CONFIG.defaultBand, scale: 'abs',
  theme: THEMES[PARAMS.get('theme')] ? PARAMS.get('theme') : THEMES[saved.theme] ? saved.theme : 'dusk',
  finish: FINISHES[PARAMS.get('finish')] ? PARAMS.get('finish') : FINISHES[saved.finish] ? saved.finish : null,
  layers: { heatmap: true, electrodes: true, labels: true, net: true, arcs: false, quality: true, ...(saved.layers || {}) },
  fit: { up: 0, fwd: 0, tilt: 0, size: 1, ...(saved.fit || {}) },
  idle: saved.idle ?? true, autoShow: saved.autoShow ?? true, bloom: saved.bloom ?? true,
  montage: saved.montage === 10 ? 10 : 19,
  source: (PARAMS.get('source') === 'ws' || PARAMS.has('ws')) ? 'ws' : 'mock',
  wsUrl: PARAMS.get('url') || PARAMS.get('ws') || CONFIG.wsDefaultUrl,
  arcThr: 0.5, proto: 'calm', sim: 'auto',
  pinned: null, hover: null,
};
S.layers.arcs = false;
function persist() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ theme: S.theme, finish: S.finish, layers: S.layers, fit: S.fit, idle: S.idle, autoShow: S.autoShow, bloom: S.bloom, montage: S.montage })); } catch { /* storage unavailable */ }
}

// ------------------------------------------------------------------ renderer / scene / camera
const host = $('gl');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.dprCap));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;           // data colours are exact; no filmic shift
renderer.xr.enabled = true;
host.appendChild(renderer.domElement);
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
labelRenderer.domElement.className = 'labels';
host.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
const world = new THREE.Group(); world.name = 'world'; scene.add(world);
const camera = new THREE.PerspectiveCamera(28, innerWidth / innerHeight, 0.02, 60);
camera.position.set(0.6, 1.6, 4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.minDistance = 0.3; controls.maxDistance = 8; controls.maxPolarAngle = 1.78;
controls.screenSpacePanning = true; controls.target.set(0, 1.55, 0);

const rt = new THREE.WebGLRenderTarget(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio(), { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(innerWidth, innerHeight);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.6, 0.4, 0.92);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const stage = buildStage(world);
const lights = buildLights(scene);
const aura = new Aura(scene, THEMES[S.theme].accent);          // world-space effects live in the scene, not the XR-offset world group
const bridge = new BrainBridge(scene, THEMES[S.theme].accent);
const sound = new Sonifier();

// ------------------------------------------------------------------ colour maps (one LUT texture per map)
function lutTex() { const t = new THREE.DataTexture(new Uint8Array(256 * 4), 256, 1); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true; return t; }
const luts = { seq: lutTex(), div: lutTex(), seqMap: null, divMap: null };
function fillLut(tex, map) { const d = tex.image.data, c = [0, 0, 0]; for (let i = 0; i < 256; i++) { map.sample(i / 255, c); d[i * 4] = c[0] * 255; d[i * 4 + 1] = c[1] * 255; d[i * 4 + 2] = c[2] * 255; d[i * 4 + 3] = 255; } tex.needsUpdate = true; }
function bgTexture(ui) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 512; const x = c.getContext('2d');
  // vertical studio sweep: lighter "cyclorama" band behind the head, falling off to the floor and ceiling
  const g = x.createLinearGradient(0, 0, 0, 512);
  if (ui === 'light') { g.addColorStop(0, '#dedbd4'); g.addColorStop(0.42, '#f4f3ef'); g.addColorStop(0.75, '#e6e3dd'); g.addColorStop(1, '#d6d2ca'); }
  else { g.addColorStop(0, '#07080a'); g.addColorStop(0.40, '#141920'); g.addColorStop(0.72, '#0b0e12'); g.addColorStop(1, '#060709'); }
  x.fillStyle = g; x.fillRect(0, 0, 64, 512);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ------------------------------------------------------------------ subjects
// subject = { id, seed, store, analytics, source, status, avatar, topo, tag, place:{x,rot} }
const subjects = [];
function makeSubject(id, seed) {
  const store = new BandPowerStore(), analytics = new Analytics(store);
  const sub = { id, seed, store, analytics, source: null, status: 'idle', statusInfo: {}, avatar: null, topo: null, tag: null, place: { x: 0, rot: 0 } };
  subjects.push(sub);
  return sub;
}
let shared = null;
function startSource(sub, kind = sub.id === 'A' ? S.source : 'mock') {
  if (sub.source) { sub.source.stop(); sub._unsub && sub._unsub.forEach(f => f()); }
  const src = createSource({ kind, url: S.wsUrl, montage: S.montage, seed: sub.seed, shared: kind === 'mock' ? shared : null, flatBand: () => S.band });
  if (src.setTarget) src.setTarget(sub.id === 'A' ? S.sim : 'auto');
  sub._unsub = [src.onFrame(f => sub.store.ingest(f)), src.onStatus((st, info) => { sub.status = st; sub.statusInfo = info; if (sub.id === 'A') ui.chip(); })];
  sub.source = src; src.start();
}
function resetData(sub) { sub.store.reset(); sub.analytics.reset(); }

const A = makeSubject('A', 0);
let baseAvatar = null;

function currentFinish() { return S.finish || THEMES[S.theme].finish; }
function attachAvatar(sub, av) {
  if (sub.topo) { sub.topo.dispose(); sub.topo.group.removeFromParent(); }
  if (sub.tag) sub.tag.element.remove();
  if (sub.avatar) world.remove(sub.avatar.root);
  sub.avatar = av;
  av.root.position.x = sub.place.x; av.root.rotation.y = sub.place.rot;
  world.add(av.root);
  av.setFinish(currentFinish());
  const topo = new Topography(av, { luts, accent: THEMES[S.theme].accent });
  topo.layers = S.layers;
  topo.band = S.band; topo.bi = BANDS.indexOf(S.band);
  if (S.scale === 'delta') { topo.setMode('delta'); topo.mixT = 1; }
  topo.build(S.fit);
  sub.topo = topo;
  // subject tag above the head
  const el = document.createElement('div'); el.className = 'subject-tag'; el.textContent = `Subject ${sub.id}`;
  sub.tag = new CSS2DObject(el); sub.tag.position.set(0, topo.r * 2.05, 0); topo.group.add(sub.tag);
  el.style.opacity = S.mode === 'duo' ? 1 : 0;
  // contact shadow
  if (!sub.shadow) sub.shadow = stage.addShadow(sub.place.x, 0);
}
function cloneAvatar(av) {
  av.resetPose();
  const c = av.clone();
  c.headCloud = av.headCloud; c.headBoxWorld = av.headBoxWorld; c.boneBind = av.boneBind.clone(); c.headBone = c.b.head || c.root;
  return c;
}
function rebuildTopos() { for (const s of subjects) if (s.topo) { s.topo.build(S.fit); s.topo.group.add(s.tag); } }
function headCentreAt(sub, out = new THREE.Vector3()) {   // head centre where the avatar is heading (sub.place)
  headCentre(sub, out);
  if (!sub || !sub.avatar) return out;
  const r = sub.avatar.root; r.updateWorldMatrix(true, false);
  r.worldToLocal(out);
  _m4.compose(_v3.set(sub.place.x, r.position.y, r.position.z), _q4.setFromAxisAngle(_v3b.set(0, 1, 0), sub.place.rot), r.scale);
  return out.applyMatrix4(_m4).applyMatrix4(world.matrixWorld);
}
const _m4 = new THREE.Matrix4(), _v3 = new THREE.Vector3(), _v3b = new THREE.Vector3(), _q4 = new THREE.Quaternion();
function headCentre(sub, out = new THREE.Vector3()) {
  if (!sub || !sub.topo) return out.set(sub ? sub.place.x : 0, 1.62, 0);
  sub.topo.group.updateWorldMatrix(true, false);
  return out.setFromMatrixPosition(sub.topo.group.matrixWorld);
}

// ------------------------------------------------------------------ loading
async function loadAvatar(src) {
  const loader = $('loader'), bar = $('loadBar'), msg = $('loadMsg'), err = $('loadErr');
  loader.classList.remove('done'); err.hidden = true; bar.style.width = '0%';
  const label = typeof src === 'string' ? src.split('/').pop() : src.name;
  msg.textContent = `Loading ${label}…`;
  try {
    const { object, name } = await loadModel(src, e => {
      if (e.lengthComputable) { bar.style.width = (e.loaded / e.total * 92).toFixed(1) + '%'; msg.textContent = `Loading ${label} · ${(e.loaded / 1048576).toFixed(1)} / ${(e.total / 1048576).toFixed(1)} MB`; }
    });
    msg.textContent = 'Fitting the 10–20 cap…'; bar.style.width = '96%';
    await new Promise(r => setTimeout(r, 30));
    const av = new Avatar(object, name);
    av.sampleHead();
    if (baseAvatar && baseAvatar !== av) baseAvatar.meshes.forEach(m => m.geometry.dispose());
    baseAvatar = av;
    attachAvatar(A, av);
    if (S.mode === 'duo' && subjects[1]) attachAvatar(subjects[1], cloneAvatar(av));
    $('avName').textContent = `${name} · ${av.bones.length} bones${av.b.head ? '' : ' · no head bone (top-of-model fit)'}`;
    bar.style.width = '100%';
    setTimeout(() => loader.classList.add('done'), 150);
    intro();
    return true;
  } catch (e) {
    console.error(e);
    err.hidden = false; err.textContent = `Couldn't load the avatar: ${e.message}. Drop an .fbx or .glb file onto the page to try another.`;
    msg.textContent = 'Load failed'; bar.style.width = '0%';
    if (baseAvatar) setTimeout(() => loader.classList.add('done'), 2600);
    return false;
  }
}

// ------------------------------------------------------------------ camera direction
const SHOTS = {
  portrait: { az: -34, polar: 80, dist: 1.22, dy: -0.075, duo: 1.9 },
  crown:    { az: 172, polar: 16, dist: 0.82, dy: 0,     duo: 1.8 },
  left:     { az: 90,  polar: 84, dist: 0.88, dy: -0.03, duo: 1.0 },
  right:    { az: -90, polar: 84, dist: 0.88, dy: -0.03, duo: 1.0 },
  back:     { az: 180, polar: 72, dist: 0.9,  dy: -0.02, duo: 1.8 },
  full:     { az: -26, polar: 84, dist: 4.6,  dy: null,  duo: 1.2 },
};
let camAnim = null;
const _sph = new THREE.Spherical(), _t0 = new THREE.Vector3(), _t1 = new THREE.Vector3();
function focusPoint(shotKey, out = new THREE.Vector3()) {
  const shot = SHOTS[shotKey], duo = S.mode === 'duo' && subjects[1] && subjects[1].topo;
  if (duo) {
    if (shotKey === 'left') headCentreAt(subjects[1], out);
    else if (shotKey === 'right') headCentreAt(A, out);
    else { headCentreAt(A, out); out.add(headCentreAt(subjects[1], _t1)).multiplyScalar(0.5); }
  } else headCentreAt(A, out);
  if (shot.dy === null) out.y = (A.avatar ? A.avatar.height : 1.75) * 0.52; else out.y += shot.dy;
  return out;
}
function flyTo(shotKey, { dur = 1600, azOffset = 0 } = {}) {
  let shot = SHOTS[shotKey]; if (!shot) return;
  const duo = S.mode === 'duo' && subjects[1];
  let to;
  if (duo && (shotKey === 'left' || shotKey === 'right')) {   // duo: Left/Right = a 3/4 portrait of Subject A / B
    const sub = shotKey === 'left' ? A : subjects[1];
    to = headCentreAt(sub, new THREE.Vector3()); to.y -= 0.06;
    shot = { az: sub.place.rot / D2R + (shotKey === 'left' ? -28 : 28), polar: 82, dist: 1.05, duo: 1 };
  } else to = focusPoint(shotKey, new THREE.Vector3());
  let dist = shot.dist * (duo ? shot.duo : 1);
  if (innerWidth / innerHeight < 1) dist *= 1.35;                            // portrait screens need more room
  _sph.setFromVector3(_t0.copy(camera.position).sub(controls.target));
  let az0 = _sph.theta, az1 = (shot.az + azOffset) * D2R;
  while (az1 - az0 > Math.PI) az1 -= 2 * Math.PI; while (az1 - az0 < -Math.PI) az1 += 2 * Math.PI;
  camAnim = { t0: performance.now(), dur: REDUCED_MOTION ? 1 : dur, fromT: controls.target.clone(), toT: to,
    from: { r: _sph.radius, polar: _sph.phi, az: az0 }, to: { r: dist, polar: shot.polar * D2R, az: az1 } };
}
function stepCamera(now) {
  if (!camAnim) return;
  const k = Math.min(1, (now - camAnim.t0) / camAnim.dur), e = easeIO(k);
  controls.target.lerpVectors(camAnim.fromT, camAnim.toT, e);
  const f = camAnim.from, t = camAnim.to;
  // a gentle "crane" arc: radius dips slightly mid-move for a dolly feel
  const r = f.r + (t.r - f.r) * e, polar = f.polar + (t.polar - f.polar) * e, az = f.az + (t.az - f.az) * e;
  _sph.set(r, polar, az); camera.position.setFromSpherical(_sph).add(controls.target);
  if (k >= 1) camAnim = null;
}
function intro() {
  const to = focusPoint('portrait');
  _sph.set(4.6, 84 * D2R, -62 * D2R);
  controls.target.set(0, 1.0, 0);
  camera.position.setFromSpherical(_sph).add(controls.target);
  flyTo('portrait', { dur: 3200 });
  void to;
}

// showcase: a cycle of shots with slow drift
const SHOW = { on: false, i: 0, t0: 0, seq: ['portrait', 'left', 'crown', 'back', 'right', 'full', 'portrait'] };
let lastInteraction = performance.now();
function setShowcase(on) {
  SHOW.on = on; $('btnShow').setAttribute('aria-pressed', on);
  if (on) { SHOW.i = 0; SHOW.t0 = performance.now(); flyTo(SHOW.seq[0], { dur: 2600 }); }
}
function stepShowcase(now, dt) {
  if (!SHOW.on) { if (S.autoShow && baseAvatar && now - lastInteraction > 40000 && !drawerOpen) setShowcase(true); return; }
  const hold = 7600;
  if (now - SHOW.t0 > hold) { SHOW.i = (SHOW.i + 1) % SHOW.seq.length; SHOW.t0 = now; flyTo(SHOW.seq[SHOW.i], { dur: 2600, azOffset: (Math.random() - 0.5) * 24 }); }
  if (!camAnim) { // drift
    _sph.setFromVector3(_t0.copy(camera.position).sub(controls.target));
    _sph.theta += dt * 0.055; camera.position.setFromSpherical(_sph).add(controls.target);
  }
}
function userInteracted() { lastInteraction = performance.now(); if (SHOW.on) setShowcase(false); }
renderer.domElement.addEventListener('pointerdown', () => { userInteracted(); camAnim = null; });
renderer.domElement.addEventListener('wheel', () => { userInteracted(); camAnim = null; }, { passive: true });

// ------------------------------------------------------------------ hover / pin
const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
let pointer = null, rayPending = false;
renderer.domElement.addEventListener('pointermove', e => { pointer = { x: e.clientX, y: e.clientY }; if (!rayPending) { rayPending = true; requestAnimationFrame(doRay); } });
renderer.domElement.addEventListener('pointerleave', () => { pointer = null; setHover(null); });
function doRay() {
  rayPending = false; if (!pointer) return;
  ndc.set(pointer.x / innerWidth * 2 - 1, -(pointer.y / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const targets = [];
  for (const s of subjects) if (s.topo && S.layers.electrodes) for (const e of s.topo.active.concat(s.topo.staleEls)) targets.push(e.hit);
  const hit = raycaster.intersectObjects(targets, false)[0];
  setHover(hit ? { sub: subjects.find(s => s.topo === hit.object.userData.topo), name: hit.object.userData.name } : null);
}
function setHover(h) {
  S.hover = h;
  host.classList.toggle('hovering', !!h);
  for (const s of subjects) if (s.topo) s.topo.hl = (S.pinned && S.pinned.sub === s ? S.pinned.name : null) || (h && h.sub === s ? h.name : null);
  ui.tooltip();
}
renderer.domElement.addEventListener('click', () => {
  if (S.hover) { S.pinned = { ...S.hover }; ui.inspect(); toast(`Inspecting ${S.pinned.name}${S.mode === 'duo' ? ` · Subject ${S.pinned.sub.id}` : ''}`); }
  setHover(S.hover);
});

// ------------------------------------------------------------------ feedback
const FB = { score: 0, raw: 0, thr: 0.65, zoneSince: null, lastChime: -1e9, session: null, ref: 'warming', inZone: false, trace: [] };
function stepFeedback(dt, now) {
  const key = S.proto === 'calm' ? 'relaxation' : 'engagement';
  const { z, ref } = A.analytics.metricZ(key, 12);
  FB.ref = ref;
  const target = ref === 'warming' || ref === 'none' ? 0 : 1 / (1 + Math.exp(-1.35 * z));
  FB.score += (target - FB.score) * (1 - Math.exp(-dt / 0.9));
  const inZone = FB.score >= FB.thr && ref !== 'warming';
  if (inZone && !FB.inZone) FB.zoneSince = now;
  if (!inZone) FB.zoneSince = null;
  FB.inZone = inZone;
  if (S.mode === 'feedback' && inZone && now - FB.zoneSince > 3000 && now - FB.lastChime > 7000) { FB.lastChime = now; sound.chime(S.proto === 'calm' ? 1 : 1.122); }
  const ss = FB.session;
  if (ss && ss.running) {
    ss.elapsed += dt; if (inZone) ss.inZone += dt;
    ss.peak = Math.max(ss.peak, FB.score);
    ss.acc += dt; if (ss.acc >= 0.5) { ss.acc = 0; ss.trace.push(FB.score); }
    if (ss.elapsed >= ss.dur) {
      ss.running = false;
      toast(`Session complete · ${Math.round(ss.inZone / ss.dur * 100)}% in zone · peak ${Math.round(ss.peak * 100)}`, 5000);
      $('fbStart').textContent = 'New session';
    }
  }
}

// ------------------------------------------------------------------ duo
const DUO = { ring: new Ring(300), last: 0, lastBands: 0, res: null, bands: [0, 0, 0, 0, 0] };
function enterDuo() {
  shared = new SharedDrive(77);
  if (S.source === 'mock') startSource(A, 'mock');
  let B = subjects[1];
  if (!B) B = makeSubject('B', 1);
  A.place = { x: -0.42, rot: 0.42 }; B.place = { x: 0.42, rot: -0.42 };
  resetData(B); startSource(B, 'mock');
  if (baseAvatar) { attachAvatar(B, cloneAvatar(baseAvatar)); B.avatar.root.position.x = 0.95; B.avatar.root.rotation.y = -1.2; }  // slides in
  DUO.ring.clear();
}
function exitDuo() {
  const B = subjects[1];
  if (B) {
    B.source && B.source.stop();
    if (B.topo) { B.topo.dispose(); B.topo.group.removeFromParent(); }
    if (B.tag) B.tag.element.remove();             // CSS2D elements outlive their removed ancestors
    if (B.avatar) world.remove(B.avatar.root);
    if (B.shadow) { stage.group.remove(B.shadow); }
    subjects.pop();
  }
  bridge.clear();
  shared = null;
  A.place = { x: 0, rot: 0 };
  if (S.source === 'mock') startSource(A, 'mock');
  if (S.pinned && S.pinned.sub !== A) S.pinned = null;
}
function stepDuo(now) {
  const B = subjects[1]; if (!B) return;
  if (now - DUO.last > 400) {
    DUO.last = now;
    DUO.res = interBrainSync(A.store, B.store, BANDS.indexOf(S.band));
    if (Number.isFinite(DUO.res.mean)) DUO.ring.push(DUO.res.mean);
  }
  if (now - DUO.lastBands > 1200) { DUO.lastBands = now; DUO.bands = BANDS.map((_, bi) => interBrainSync(A.store, B.store, bi).mean); }
}

// ------------------------------------------------------------------ modes
function setMode(mode) {
  const prev = S.mode; if (prev === mode && setMode._init) return;
  setMode._init = true;
  if (prev === 'duo' && mode !== 'duo') exitDuo();
  S.mode = mode;
  if (mode === 'duo' && (prev !== 'duo' || !subjects[1])) enterDuo();
  if (mode === 'network') setLayer('arcs', true); else if (prev === 'network') setLayer('arcs', false);
  document.querySelectorAll('.modes button').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === mode));
  $('netCard').hidden = mode !== 'network';
  $('fbCard').hidden = mode !== 'feedback';
  $('duoCard').hidden = mode !== 'duo';
  $('inspCard').hidden = mode === 'duo';
  $('metricsCard').hidden = false;
  for (const s of subjects) if (s.tag) s.tag.element.style.opacity = mode === 'duo' ? 1 : 0;
  ui.simCaption();
  if (baseAvatar) flyTo('portrait', { dur: 1800 });
  ui.subtitle();
}

// ------------------------------------------------------------------ settings actions
function setBand(band) {
  if (!BANDS.includes(band)) return;
  S.band = band;
  for (const s of subjects) s.topo && s.topo.setBand(band);
  ui.band(); ui.legend(true); ui.inspect();
  DUO.ring.clear();
}
function setScale(scale) {
  if (scale === 'delta' && A.analytics.baseline.state !== 'ready') {
    if (A.analytics.baseline.state !== 'recording') calibrate(true);
    toast('Δ Baseline needs a baseline: recording 20 s, then it switches over');
    return;
  }
  S.scale = scale;
  for (const s of subjects) s.topo && s.topo.setMode(scale);
  document.querySelectorAll('#scaleSeg button').forEach(b => b.setAttribute('aria-checked', b.dataset.scale === scale));
  ui.legend(true);
}
let switchToDeltaWhenReady = false;
function calibrate(thenDelta = true) {
  for (const s of subjects) s.analytics.startBaseline(CONFIG.baselineSec);
  switchToDeltaWhenReady = thenDelta;
  toast(`Recording a ${CONFIG.baselineSec} s baseline · keep the subject at rest`);
}
function setLayer(k, on) {
  S.layers[k] = on;
  const cb = document.querySelector(`[data-layer="${k}"]`); if (cb) cb.checked = on;
  if (k !== 'arcs') persist();
}
function applyTheme(key) {
  S.theme = key; const T = THEMES[key];
  document.documentElement.dataset.theme = key; document.documentElement.dataset.ui = T.ui;
  luts.seqMap = makeMap(T.seq); luts.divMap = makeMap(T.div);
  fillLut(luts.seq, luts.seqMap); fillLut(luts.div, luts.divMap);
  for (const s of subjects) if (s.topo) s.topo.setLUTs(luts, T.accent);
  aura.setAccent(T.accent); bridge.setAccent(T.accent);
  if (scene.background && scene.background.dispose) scene.background.dispose();
  scene.background = bgTexture(T.ui);
  const light = T.ui === 'light';
  stage.floorU.uGrid.value.set(light ? 0x6b7280 : 0x8a96a8); stage.floorU.uBase.value.set(light ? 0xd5d1c9 : 0x0d1015);
  stage.floorU.uGridA.value = light ? 0.09 : 0.07;
  lights.hemi.intensity = light ? 1.5 : 0.9; lights.hemi.groundColor.set(light ? 0x9a948a : 0x0b0d10);
  lights.rim.color.set(light ? 0xffffff : 0x9fb8ff);
  bloom.strength = light ? 0.22 : 0.6;
  if (!S.finish) for (const s of subjects) s.avatar && s.avatar.setFinish(T.finish);
  ui.themeState(); ui.legend(true); ui.band();
  persist();
}
function setFinish(key) {
  S.finish = key;
  for (const s of subjects) s.avatar && s.avatar.setFinish(key);
  ui.finishState(); persist();
}
function setSim(state) {
  S.sim = state;
  if (A.source && A.source.setTarget) A.source.setTarget(state);
  document.querySelectorAll('#states button').forEach(b => b.setAttribute('aria-checked', b.dataset.sim === state));
}
function setMontage(n) {
  S.montage = n; persist();
  for (const s of subjects) { resetData(s); if (s.source && s.source.kind === 'mock') startSource(s, 'mock'); }
  document.querySelectorAll('#montSeg button').forEach(b => b.setAttribute('aria-checked', +b.dataset.mont === n));
  ui.subtitle();
}
function setSource(kind) {
  S.source = kind;
  document.querySelectorAll('#srcSeg button').forEach(b => b.setAttribute('aria-checked', b.dataset.src === kind));
  $('wsRow').hidden = kind !== 'ws';
  resetData(A);
  if (kind === 'mock') startSource(A, 'mock');
  else { if (A.source) A.source.stop(); A.source = null; A.status = 'disconnected'; A.statusInfo = { reason: 'not connected' }; ui.chip(); }
  $('simSec').hidden = kind !== 'mock';
  ui.subtitle();
}

// ------------------------------------------------------------------ toast
let toastTimer = 0;
function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), ms); }

// ------------------------------------------------------------------ UI
const fmtNum = v => { if (!Number.isFinite(v)) return '–'; const a = Math.abs(v); if (a >= 100) return v.toFixed(0); if (a >= 10) return v.toFixed(1); if (a >= 0.01) return v.toFixed(2); return v.toExponential(1); };
const unitLabel = u => (u === 'uV^2' || !u ? 'µV²' : u === 'relative' ? 'rel.' : u);
const spectrogram = new Spectrogram($('sgramChart'), 300);
let specRange = null, inspectedKey = '';

const ui = {
  build() {
    // bands
    $('bands').innerHTML = BANDS.map((b, i) => `<button type="button" role="radio" data-band="${b}" aria-checked="${b === S.band}" title="${BAND_INFO[b].label} · ${BAND_INFO[b].hz} (${i + 1})"><b>${BAND_INFO[b].glyph}</b><span>${BAND_INFO[b].label}</span></button>`).join('');
    $('bands').onclick = e => { const b = e.target.closest('button'); if (b) setBand(b.dataset.band); };
    $('scaleSeg').onclick = e => { const b = e.target.closest('button'); if (b) setScale(b.dataset.scale); };
    $('btnCalib').onclick = () => calibrate(true);
    $('layers').onchange = e => { const k = e.target.dataset.layer; if (k) setLayer(k, e.target.checked); };
    for (const [k, v] of Object.entries(S.layers)) { const cb = document.querySelector(`[data-layer="${k}"]`); if (cb) cb.checked = v; }
    $('states').innerHTML = ['auto', 'rest', 'focus', 'relax', 'drowsy'].map(s => `<button type="button" role="radio" data-sim="${s}" aria-checked="${s === S.sim}">${SIM_LABEL[s]}</button>`).join('');
    $('states').onclick = e => { const b = e.target.closest('button'); if (b) setSim(b.dataset.sim); };
    // metrics
    $('metrics').innerHTML = METRIC_KEYS.map(k => `<div class="metric" title="${METRICS[k].formula} · ${METRICS[k].desc}"><div class="k"><span>${METRICS[k].label}</span><span class="trend" id="mt_${k}"></span></div><div class="v"><span id="mv_${k}">–</span><small>${METRICS[k].short}</small></div><canvas id="mc_${k}" width="120" height="26"></canvas><div class="q" id="mq_${k}">–</div></div>`).join('');
    // modes, dock, top
    document.querySelector('.modes').onclick = e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); };
    $('dock').onclick = e => { const b = e.target.closest('button[data-shot]'); if (b) { userInteracted(); flyTo(b.dataset.shot); } };
    $('btnShow').onclick = () => { lastInteraction = performance.now(); setShowcase(!SHOW.on); };
    $('btnCinema').onclick = () => toggleCinema();
    $('btnAudio').onclick = async () => { const on = await sound.toggle(); $('btnAudio').setAttribute('aria-pressed', on); toast(on ? 'Sonification on · each band is a voice' : 'Sound off'); };
    $('btnSettings').onclick = () => openDrawer(true);
    $('btnClose').onclick = () => openDrawer(false);
    $('scrim').onclick = () => openDrawer(false);
    // network
    $('arcThr').oninput = e => { S.arcThr = +e.target.value; $('arcThrOut').textContent = S.arcThr.toFixed(2); };
    // feedback
    $('fbProto').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.proto = b.dataset.proto; document.querySelectorAll('#fbProto button').forEach(x => x.setAttribute('aria-checked', x === b)); ui.simCaption(); };
    $('fbStart').onclick = () => {
      const ss = FB.session;
      if (ss && ss.running) { ss.running = false; $('fbStart').textContent = 'Resume'; return; }
      if (ss && !ss.running && ss.elapsed > 0 && ss.elapsed < ss.dur) { ss.running = true; $('fbStart').textContent = 'Pause'; return; }
      FB.session = { running: true, dur: +$('fbDur').value, elapsed: 0, inZone: 0, peak: 0, acc: 0, trace: [] };
      $('fbStart').textContent = 'Pause';
      toast(`Session started · ${S.proto === 'calm' ? 'raise alpha relative to beta' : 'raise beta relative to alpha + theta'}`);
    };
    // drawer: themes, finishes, avatar, fit, options, data
    $('themes').innerHTML = THEME_KEYS.map(k => `<button type="button" role="radio" data-theme="${k}" aria-checked="${k === S.theme}"><i style="background:${makeMap(THEMES[k].seq).gradient()}"></i><span>${THEMES[k].label}<small>${THEMES[k].sub}</small></span></button>`).join('');
    $('themes').onclick = e => { const b = e.target.closest('button'); if (b) applyTheme(b.dataset.theme); };
    $('finishes').innerHTML = Object.entries(FINISHES).map(([k, f]) => `<button type="button" role="radio" data-finish="${k}" aria-checked="false"><i class="f-${k}"></i>${f.label}</button>`).join('');
    $('finishes').onclick = e => { const b = e.target.closest('button'); if (b) setFinish(b.dataset.finish); };
    $('avFile').onchange = e => { const f = e.target.files[0]; if (f) loadAvatar(f); e.target.value = ''; };
    const fitIn = (id, key, fmt) => { const el = $(id), out = $(id + 'O'); el.value = S.fit[key]; out.textContent = fmt(S.fit[key]); el.oninput = () => { S.fit[key] = +el.value; out.textContent = fmt(S.fit[key]); clearTimeout(fitIn.t); fitIn.t = setTimeout(() => { rebuildTopos(); persist(); }, 60); }; };
    fitIn('fitUp', 'up', v => (v >= 0 ? '+' : '') + v.toFixed(2)); fitIn('fitFwd', 'fwd', v => (v >= 0 ? '+' : '') + v.toFixed(2)); fitIn('fitTilt', 'tilt', v => v.toFixed(0) + '°');
    $('fitReset').onclick = () => { S.fit = { up: 0, fwd: 0, tilt: 0, size: 1 }; ['fitUp', 'fitFwd', 'fitTilt'].forEach(id => { $(id).value = 0; $(id).dispatchEvent(new Event('input')); }); };
    const opt = (id, key, fn) => { $(id).checked = S[key]; $(id).onchange = e => { S[key] = e.target.checked; fn && fn(); persist(); }; };
    opt('optIdle', 'idle', () => { if (!S.idle) for (const s of subjects) s.avatar && s.avatar.resetPose(); });
    opt('optAutoShow', 'autoShow');
    opt('optBloom', 'bloom', () => (bloom.enabled = S.bloom));
    bloom.enabled = S.bloom;
    $('montSeg').onclick = e => { const b = e.target.closest('button'); if (b) setMontage(+b.dataset.mont); };
    document.querySelectorAll('#montSeg button').forEach(b => b.setAttribute('aria-checked', +b.dataset.mont === S.montage));
    $('srcSeg').onclick = e => { const b = e.target.closest('button'); if (b) setSource(b.dataset.src); };
    $('wsUrl').value = S.wsUrl;
    $('wsBtn').onclick = () => { S.wsUrl = $('wsUrl').value.trim(); resetData(A); startSource(A, 'ws'); };
    this.syncBars();
  },
  syncBars() { $('syncBars').innerHTML = BANDS.map(b => `<div><i data-b="${b}"></i><span>${BAND_INFO[b].glyph}</span></div>`).join(''); },
  band() {
    document.querySelectorAll('#bands button').forEach(b => b.setAttribute('aria-checked', b.dataset.band === S.band));
    $('bandDesc').textContent = `${BAND_INFO[S.band].hz} · ${BAND_INFO[S.band].desc}`;
    $('duoBand').textContent = BAND_INFO[S.band].label;
  },
  themeState() { document.querySelectorAll('#themes button').forEach(b => b.setAttribute('aria-checked', b.dataset.theme === S.theme)); this.finishState(); },
  finishState() { const f = currentFinish(); document.querySelectorAll('#finishes button').forEach(b => b.setAttribute('aria-checked', b.dataset.finish === f)); },
  subtitle() {
    const n = A.store.list.filter(r => !r.stale && r.m).length || S.montage;
    $('subtitle').textContent = S.source === 'mock' ? `${S.mode === 'duo' ? 'Two synthetic subjects' : 'Synthetic subject'} · ${n} ch · 10–20` : `Live stream · ${n} ch · 10–20`;
  },
  chip() {
    const chip = $('chip'), st = A.status, info = A.statusInfo || {};
    chip.dataset.state = st;
    const L = { mock: 'Synthetic', live: 'Live', connecting: 'Connecting', stale: 'Stale', disconnected: 'Disconnected', idle: '–' }[st] || st;
    $('chipLabel').textContent = L;
    let s = '';
    if (st === 'mock') s = `${CONFIG.rateHz} Hz`;
    else if (st === 'live') s = `${(A.source && A.source.rate || 0).toFixed(0)} Hz`;
    else if (st === 'connecting') s = info.open ? 'waiting for data' : S.wsUrl.replace(/^wss?:\/\//, '');
    else if (st === 'stale') s = 'no data';
    else if (st === 'disconnected') s = info.retryAt ? `retry ${Math.max(0, Math.ceil((info.retryAt - performance.now()) / 1000))} s` : info.reason || '';
    $('chipInfo').textContent = s;
  },
  simCaption() {
    if (S.source !== 'mock') return;
    const st = A.source && A.source.simState;
    $('simNow').innerHTML = `<i></i>${SIM_LABEL[st] || '–'}`;
    $('simCap').textContent = S.mode === 'feedback'
      ? `Synthetic subject: pick ${S.proto === 'calm' ? 'Relax' : 'Focus'} to watch the score climb, ${S.proto === 'calm' ? 'Focus' : 'Drowsy'} to see it fall.`
      : S.mode === 'duo' ? 'Drives Subject A. Subject B wanders on its own; shared drive episodes create synchrony.'
        : 'Drive the synthetic brain state. Auto wanders between states.';
  },
  legend(force) {
    const delta = S.scale === 'delta' && A.analytics.baseline.state === 'ready';
    const map = delta ? luts.divMap : luts.seqMap;
    if (!map) return;
    const bi = BANDS.indexOf(S.band);
    if (force) $('legendBar').style.background = map.gradient();
    $('legendTitle').textContent = delta ? `${BAND_INFO[S.band].label} change vs baseline` : `${BAND_INFO[S.band].label} power`;
    $('legendUnit').textContent = delta ? '(dB)' : `(${unitLabel(A.store.units)})`;
    let ticks;
    if (delta) { const D = A.analytics.dRange[bi]; ticks = [-D, -D / 2, 0, D / 2, D].map(v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1)); }
    else { const r = A.store.range(S.band); ticks = [0, 0.25, 0.5, 0.75, 1].map(f => fmtNum(r.lo + (r.hi - r.lo) * f)); }
    const key = ticks.join('|');
    if (key !== this._tk) { this._tk = key; $('ticks').innerHTML = ticks.map((t, i) => `<span class="${i === 0 ? 'first' : i === 4 ? 'last' : ''}" style="left:${i * 25}%">${t}</span>`).join(''); }
    const clip = A.store.range(S.band).clip;
    $('legendCap').textContent = delta ? 'Symmetric range · centre = no change' : 'Per-band auto range · 20 s';
    $('legendCap2').textContent = !delta && Number.isFinite(clip) ? `peak ${fmtNum(clip)} clipped` : S.mode === 'network' ? 'Arcs: envelope r ≥ ' + S.arcThr.toFixed(2) : '';
    // hover marker
    const h = S.hover || S.pinned, mk = $('legendMarker');
    if (h && h.sub && h.sub.topo) { const e = h.sub.topo.byName.get(h.name); if (e && e.idx >= 0) { mk.style.left = (h.sub.topo.shown[e.idx] * 100).toFixed(1) + '%'; mk.style.opacity = 1; } else mk.style.opacity = 0; }
    else mk.style.opacity = 0;
  },
  tooltip() {
    const tt = $('tooltip'), h = S.hover;
    if (!h || !pointer || !h.sub) { tt.classList.add('off'); return; }
    const r = h.sub.store.record(h.name), m = r && r.m, bi = BANDS.indexOf(S.band);
    $('ttName').textContent = h.name + (S.mode === 'duo' ? ` · ${h.sub.id}` : '');
    $('ttRegion').textContent = m ? m.region : '';
    const delta = S.scale === 'delta' && h.sub.analytics.baseline.state === 'ready';
    if (r && r.has[bi]) {
      $('ttValue').textContent = delta ? (r.db[bi] >= 0 ? '+' : '−') + Math.abs(r.db[bi]).toFixed(1) : fmtNum(r.raw[bi]);
      $('ttUnit').textContent = delta ? 'dB vs baseline' : unitLabel(h.sub.store.units);
      $('ttPct').textContent = r.stale ? 'Stale · no recent data' : `${Math.round(r.norm[bi] * 100)}% of range · quality ${r.quality > 0.75 ? 'good' : r.quality > 0.45 ? 'fair' : 'poor'}`;
      const vals = new Float32Array(100), c = h.sub.store.tail(r, bi, 100, vals);
      sparkline($('ttSpark'), vals.subarray(0, c), { color: cssVar('--accent') });
    } else { $('ttValue').textContent = '–'; $('ttPct').textContent = 'No data for this band'; }
    const x = Math.min(innerWidth - 230, pointer.x + 16), y = Math.min(innerHeight - 150, pointer.y + 16);
    tt.style.transform = `translate(${x}px, ${y}px)`; tt.classList.remove('off');
  },
  inspect() {
    const sub = (S.pinned && S.pinned.sub) || A;
    let name = S.pinned ? S.pinned.name : null;
    if (!name || !sub.store.record(name)) { const pref = ['O1', 'Oz', 'O2', 'Pz', 'P3']; name = pref.find(n => sub.store.record(n)) || (sub.store.list[0] && sub.store.list[0].name) || 'O1'; }
    const key = sub.id + name + S.band;
    const r = sub.store.record(name);
    $('inName').textContent = name; $('inRegion').textContent = r && r.m ? r.m.region : '';
    if (key !== inspectedKey) {        // rebuild the spectrogram from history so it never starts empty
      inspectedKey = key; spectrogram.clear(); specRange = null;
      if (r) {
        const n = Math.min(300, r.hist[0].count), cols = BANDS.map(() => new Float32Array(n));
        BANDS.forEach((_, b) => sub.store.tail(r, b, n, cols[b]));
        const raw = new Float64Array(5), spec = new Float32Array(72);
        for (let i = 0; i < n; i++) { for (let b = 0; b < 5; b++) raw[b] = cols[b][i]; spectrumFromBands(raw, r.has, spec); spectrogram.push(spec); }
      }
    }
    return { sub, name, r };
  },
  // 10 Hz panel refresh
  tick(now) {
    const accent = cssVar('--accent'), text1 = cssVar('--text-1'), text3 = cssVar('--text-3');
    // baseline progress
    const B = A.analytics.baseline;
    $('calibBar').style.width = (B.state === 'recording' ? B.progress * 100 : B.state === 'ready' ? 100 : 0).toFixed(1) + '%';
    $('calibCap').textContent = B.state === 'recording' ? `Recording · ${Math.ceil((1 - B.progress) * B.dur)} s left` : B.state === 'ready' ? `Baseline · ${Math.round((now - B.at) / 60000)} min ago` : 'No baseline recorded';
    $('btnCalib').textContent = B.state === 'ready' ? 'Recalibrate' : 'Calibrate';
    if (B.state === 'ready' && switchToDeltaWhenReady) { switchToDeltaWhenReady = false; setScale('delta'); toast('Baseline recorded · now showing change vs baseline'); }
    this.simCaption(); this.legend(false); this.chip();
    if (now - (this._sub || 0) > 2000) { this._sub = now; this.subtitle(); }
    // metrics
    for (const k of METRIC_KEYS) {
      const ring = A.analytics.metric[k], st = ring.stats(10), M = METRICS[k];
      $('mv_' + k).textContent = Number.isFinite(st.mu) ? M.fmt(st.mu) : '–';
      const prev = ring.count > 70 ? (() => { let s = 0, c = 0; for (let i = ring.count - 70; i < ring.count - 60; i++) { const v = ring.at(i); if (Number.isFinite(v)) { s += v; c++; } } return c ? s / c : NaN; })() : NaN;
      const tr = $('mt_' + k);
      if (Number.isFinite(prev) && Number.isFinite(st.mu)) {
        const d = M.log ? Math.log(st.mu / prev) : st.mu - prev;
        tr.className = 'trend ' + (d > 0.06 ? 'up' : d < -0.06 ? 'down' : ''); tr.textContent = d > 0.06 ? '▲' : d < -0.06 ? '▼' : '';
      } else tr.textContent = '';
      const vals = new Float32Array(ring.count); let acc = 0, na = 0; const win = [];
      for (let i = 0; i < ring.count; i++) { const v = ring.at(i); if (Number.isFinite(v)) { win.push(v); acc += v; na++; if (win.length > 8) { acc -= win.shift(); na--; } } vals[i] = na ? acc / na : NaN; }
      const bm = B.state === 'ready' && B.metric[k] ? (M.log ? Math.exp(B.metric[k].mu) : B.metric[k].mu) : null;
      sparkline($('mc_' + k), vals, { color: accent, ref: bm });
      const { z, ref } = A.analytics.metricZ(k, 10);
      const za = Math.abs(z), zs = za > 9.9 ? '>9.9' : za.toFixed(1);
      $('mq_' + k).textContent = ref === 'warming' || ref === 'none' ? 'collecting…' : `${z >= 0 ? '+' : '−'}${zs}σ vs ${ref === 'baseline' ? 'baseline' : '60 s'}`;
    }
    $('metricsRef').textContent = B.state === 'ready' ? 'vs baseline' : '60 s window';
    $('metricsLbl').textContent = S.mode === 'duo' ? 'Brain state · Subject A' : 'Brain state';
    // inspector
    if (!$('inspCard').hidden) {
      const { sub, r } = this.inspect();
      const bi = BANDS.indexOf(S.band);
      if (r) {
        const spec = spectrumFromBands(r.raw, r.has);
        let ghost = null;
        const bmu = sub.analytics.baseline.state === 'ready' ? sub.analytics.baseline.mean.get(r.name) : null;
        if (bmu) ghost = spectrumFromBands(Float64Array.from(bmu, v => Math.pow(10, v)), r.has);
        let lo = Infinity, hi = -Infinity; for (const v of spec) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
        if (!specRange) specRange = [lo, hi]; else { specRange[0] = Math.min(lo, specRange[0] + 0.01); specRange[1] = Math.max(hi, specRange[1] - 0.01); }
        const t = sub.topo && sub.topo.byName.get(r.name), v = t && t.idx >= 0 ? sub.topo.shown[t.idx] : r.norm[bi];
        const map = S.scale === 'delta' && sub.analytics.baseline.state === 'ready' ? luts.divMap : luts.seqMap;
        drawSpectrum($('specChart'), spec, { band: S.band, bandColor: map.css(Math.max(0.35, v)), ghost, yRange: specRange });
        if (sub.store.frames !== this._sgFrame) { this._sgFrame = sub.store.frames; spectrogram.push(spec); }
        spectrogram.draw(luts.seqMap);
        const q = $('inQ'); q.textContent = r.stale ? 'Stale' : r.quality > 0.75 ? 'Good' : r.quality > 0.45 ? 'Fair' : 'Poor';
        q.className = 'qbadge ' + (r.stale || r.quality <= 0.45 ? 'poor' : r.quality <= 0.75 ? 'fair' : '');
      }
    }
    // network
    if (S.mode === 'network' && A.topo) {
      const links = A.topo.strongestLinks(5);
      $('netLinks').textContent = A.topo.arcs.filter(a => a.target >= S.arcThr).length;
      $('netDensity').textContent = (A.topo.density(S.arcThr) * 100).toFixed(0) + '%';
      $('netList').innerHTML = links.map(l => `<li><span>${l.a} ↔ ${l.b}</span><i style="transform:scaleX(${clamp(l.target).toFixed(2)})"></i><span style="text-align:right">${l.target.toFixed(2)}</span></li>`).join('');
    }
    // feedback
    if (S.mode === 'feedback') {
      const L = 395.8, sc = FB.score, ss = FB.session;
      $('dialArc').setAttribute('stroke-dasharray', `${(sc * L).toFixed(1)} 527.8`);
      $('dialZone').setAttribute('stroke-dasharray', `0 ${(FB.thr * L).toFixed(1)} ${((1 - FB.thr) * L).toFixed(1)} 999`);
      const warming = FB.ref === 'warming' || FB.ref === 'none';
      $('fbScore').textContent = warming ? '–' : Math.round(sc * 100);
      const z = $('fbZone'); z.textContent = warming ? 'collecting a reference…' : FB.inZone ? 'In the zone' : sc > 0.5 ? 'Getting there' : S.proto === 'calm' ? 'Unsettled' : 'Unfocused'; z.className = FB.inZone ? 'zone' : '';
      $('fbRef').textContent = FB.ref === 'baseline' ? 'vs your baseline' : 'vs rolling 60 s';
      $('fbIn').textContent = ss && ss.elapsed > 0 ? Math.round(ss.inZone / ss.elapsed * 100) + '%' : '–';
      $('fbStreak').textContent = FB.inZone && FB.zoneSince ? ((now - FB.zoneSince) / 1000).toFixed(0) + ' s' : '–';
      const el = ss ? ss.elapsed : 0; $('fbTime').textContent = `${Math.floor(el / 60)}:${String(Math.floor(el % 60)).padStart(2, '0')}`;
      FB.trace.push(sc); if (FB.trace.length > 300) FB.trace.shift();
      traceChart($('fbChart'), ss ? ss.trace : FB.trace, { color: accent, threshold: FB.thr, capacity: ss ? Math.max(ss.trace.length, Math.ceil(ss.dur * 2)) : 300 });
    }
    // duo
    if (S.mode === 'duo' && DUO.res) {
      const m = DUO.ring.stats(5).mu;
      $('syncVal').textContent = Number.isFinite(m) ? m.toFixed(2) : '–';
      $('syncWord').textContent = !Number.isFinite(m) ? 'warming up' : m > 0.6 ? 'strongly in sync' : m > 0.35 ? 'loosely coupled' : m > 0.1 ? 'mostly independent' : 'independent';
      const vals = []; for (let i = 0; i < DUO.ring.count; i++) vals.push(DUO.ring.at(i));
      traceChart($('syncChart'), vals, { color: accent, threshold: S.arcThr, capacity: 300, min: -0.2, max: 1 });
      document.querySelectorAll('#syncBars i').forEach((el, i) => { const v = DUO.bands[i]; el.style.height = (4 + Math.max(0, Number.isFinite(v) ? v : 0) * 56).toFixed(0) + 'px'; el.classList.toggle('on', BANDS[i] === S.band); });
      const top = (DUO.res.pairs || []).slice().sort((a, b) => b.r - a.r).slice(0, 4);
      $('syncList').innerHTML = top.map(p => `<li><span>${p.name} ↔ ${p.name}</span><i style="transform:scaleX(${clamp(p.r).toFixed(2)})"></i><span style="text-align:right">${p.r.toFixed(2)}</span></li>`).join('');
    }
    void text1; void text3;
  },
};

// ------------------------------------------------------------------ drawer, cinema, drag & drop, keys
let drawerOpen = false;
function openDrawer(on) {
  drawerOpen = on; $('drawer').classList.toggle('on', on); $('scrim').classList.toggle('on', on);
  $('drawer').setAttribute('aria-hidden', !on); $('btnSettings').setAttribute('aria-expanded', on);
  if (on) { userInteracted(); setTimeout(() => $('btnClose').focus(), 50); }
}
function toggleCinema() { const on = document.body.classList.toggle('cinema'); if (on) toast('Interface hidden · press H to bring it back'); }
let dragDepth = 0;
addEventListener('dragenter', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; $('drop').classList.add('on'); e.preventDefault(); } });
addEventListener('dragover', e => e.preventDefault());
addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop').classList.remove('on'); });
addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('drop').classList.remove('on'); const f = e.dataTransfer.files[0]; if (f) loadAvatar(f); });
addEventListener('keydown', e => {
  if (e.target.matches('input[type=text], select')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k >= '1' && k <= '5') setBand(BANDS[+k - 1]);
  else if (k === 'm') { const ms = ['topo', 'network', 'feedback', 'duo']; setMode(ms[(ms.indexOf(S.mode) + 1) % ms.length]); }
  else if (k === 'b') setScale(S.scale === 'abs' ? 'delta' : 'abs');
  else if (k === 'c') calibrate(true);
  else if (k === 'n') setLayer('arcs', !S.layers.arcs);
  else if (k === 's') setShowcase(!SHOW.on);
  else if (k === 'h') toggleCinema();
  else if (k === 'a') $('btnAudio').click();
  else if (k === ',') openDrawer(!drawerOpen);
  else if (k === 'escape') { if (drawerOpen) openDrawer(false); else if (document.body.classList.contains('cinema')) toggleCinema(); else { S.pinned = null; setHover(S.hover); ui.inspect(); } }
  else return;
  if (k !== 's') userInteracted(); else lastInteraction = performance.now();
});

// ------------------------------------------------------------------ WebXR
const vrBtn = $('btnVR');
if (navigator.xr && navigator.xr.isSessionSupported) navigator.xr.isSessionSupported('immersive-vr').then(ok => { vrBtn.hidden = !ok; }).catch(() => {});
vrBtn.onclick = async () => {
  try {
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(session);
    world.position.set(0, 0, -1.3);              // life-size avatar(s), 1.3 m in front of you
    const bg = scene.background; scene.background = new THREE.Color(THEMES[S.theme].ui === 'light' ? 0xe9e7e2 : 0x0b0d10);
    session.addEventListener('end', () => { world.position.set(0, 0, 0); scene.background = bg; });
  } catch (e) { toast(`VR unavailable: ${e.message}`); }
};

// ------------------------------------------------------------------ resize
function onResize() {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setSize(w, h); composer.setSize(w, h); labelRenderer.setSize(w, h); bloom.setSize(w / 2, h / 2);
}
addEventListener('resize', onResize);

// ------------------------------------------------------------------ main loop
let last = performance.now(), uiAt = 0, clockT = 0;
const _hc = new THREE.Vector3();
function frame() {
  const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now; clockT += dt;
  // placement (duo transitions)
  for (const s of subjects) if (s.avatar) {
    const r = s.avatar.root, k = 1 - Math.exp(-dt / 0.45);
    r.position.x += (s.place.x - r.position.x) * k; r.rotation.y += (s.place.rot - r.rotation.y) * k;
    if (s.shadow) s.shadow.position.x = r.position.x;
    if (S.idle) s.avatar.idle(clockT, 1);
  }
  const fpx = innerHeight / (2 * Math.tan(camera.fov * D2R / 2));
  for (const s of subjects) if (s.topo) {
    const headPx = s.topo.r * fpx / Math.max(0.05, camera.position.distanceTo(headCentre(s, _hc)));
    s.topo.update(dt, now, { store: s.store, analytics: s.analytics, status: s.status, camera, arcThreshold: S.arcThr, labelsFit: headPx > 62 });
  }
  stepFeedback(dt, now);
  if (S.mode === 'duo') { stepDuo(now); const B = subjects[1]; if (A.topo && B && B.topo) bridge.update(dt, DUO.res && DUO.res.pairs, A.topo.byName, B.topo.byName, S.arcThr, true); }
  if (A.topo) { headCentre(A, _hc); aura.update(dt, clockT, { on: S.mode === 'feedback', score: FB.score, center: _hc, r: A.topo.r, px: renderer.getPixelRatio() * innerHeight / 900 }); }
  // audio levels: mean normalised power per band
  if (sound.on) { const lv = BANDS.map((_, b) => { let s = 0, c = 0; for (const r of A.store.list) if (!r.stale && r.has[b]) { s += r.norm[b]; c++; } return c ? s / c : 0; }); sound.update(lv, S.mode === 'feedback' ? FB.score : null); }
  if (!renderer.xr.isPresenting) { stepShowcase(now, dt); stepCamera(now); controls.update(); }
  if (now - uiAt > 100) { uiAt = now; ui.tick(now); if (S.hover) ui.tooltip(); }
  if (renderer.xr.isPresenting) renderer.render(scene, camera);
  else { composer.render(); labelRenderer.render(scene, camera); }
}

// ------------------------------------------------------------------ boot
ui.build();
applyTheme(S.theme);
ui.band();
setSim(S.sim);
$('simSec').hidden = S.source !== 'mock';
document.querySelectorAll('#srcSeg button').forEach(b => b.setAttribute('aria-checked', b.dataset.src === S.source));
$('wsRow').hidden = S.source !== 'ws';
startSource(A);
setMode(S.mode);
renderer.setAnimationLoop(frame);
loadAvatar(CONFIG.avatarUrl);

// debug / automation hook
window.__studio = { S, subjects, setBand, setMode, setScale, setTheme: applyTheme, setFinish, setSim, flyTo, calibrate, setLayer, FB, DUO, camera, controls, loadAvatar, get ready() { return !!(A.topo && A.topo.cap); } };
