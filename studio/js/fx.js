// ===== STAGE + EFFECTS =====
// Studio stage (floor disc, polar grid, contact shadow), neurofeedback aura, inter-brain arcs.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { sstep } from './config.js';

export function buildStage(scene) {
  const g = new THREE.Group(); g.name = 'stage';
  // floor: radial fade disc + fine polar grid, both in one shader so the edges dissolve into the background
  const floorU = { uGrid: { value: new THREE.Color(0x8a96a8) }, uBase: { value: new THREE.Color(0x0e1116) }, uGridA: { value: 0.07 }, uBaseA: { value: 0.9 } };
  const floor = new THREE.Mesh(new THREE.CircleGeometry(4, 96), new THREE.ShaderMaterial({
    uniforms: floorU, transparent: true, depthWrite: false,
    vertexShader: `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uGrid; uniform vec3 uBase; uniform float uGridA; uniform float uBaseA; varying vec2 vP;
      void main(){
        float r = length(vP), a = atan(vP.y, vP.x);
        float fade = 1.0 - smoothstep(0.6, 3.6, r);
        float rings = abs(fract(r / 0.25 - 0.5) - 0.5) / fwidth(r / 0.25);
        float spokes = abs(fract(a / 6.2831853 * 24.0 - 0.5) - 0.5) / fwidth(a / 6.2831853 * 24.0);
        float line = 1.0 - min(min(rings, spokes * step(0.5, r)), 1.0);
        float shadow = 1.0 - smoothstep(0.0, 0.42, r) * 0.0;
        vec3 col = mix(uBase, uGrid, line * uGridA * 4.0);
        float alpha = fade * (uBaseA * 0.55 + line * uGridA);
        gl_FragColor = vec4(col, alpha);
      }`,
  }));
  floor.rotation.x = -Math.PI / 2; floor.renderOrder = -2; g.add(floor);
  // contact shadow under the feet
  const sc = document.createElement('canvas'); sc.width = sc.height = 128; const x = sc.getContext('2d');
  const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(0,0,0,0.75)'); gr.addColorStop(0.5, 'rgba(0,0,0,0.3)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
  const shadowMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false });
  const shadows = [];
  const addShadow = (xp, zp) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), shadowMat); m.rotation.x = -Math.PI / 2; m.position.set(xp, 0.002, zp); m.renderOrder = -1; g.add(m); shadows.push(m); return m; };
  scene.add(g);
  return { group: g, floorU, addShadow, shadows };
}

export function buildLights(scene) {
  const hemi = new THREE.HemisphereLight(0xc9d4e6, 0x0b0d10, 0.9);
  const key = new THREE.DirectionalLight(0xfff1e2, 2.6); key.position.set(-1.6, 3.2, 2.6);
  const rim = new THREE.DirectionalLight(0x9fb8ff, 2.2); rim.position.set(2.2, 2.4, -2.8);
  const fill = new THREE.DirectionalLight(0xffffff, 0.55); fill.position.set(2.5, 1.2, 2.0);
  scene.add(hemi, key, rim, fill);
  return { hemi, key, rim, fill };
}

// ---------------------------------------------------------------- neurofeedback aura
// Particles orbit the head. Low score: dim, slow, scattered. High score: a bright, ordered, flowing halo.
export class Aura {
  constructor(scene, accent) {
    const N = 1400, seeds = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) { seeds[i * 4] = Math.random(); seeds[i * 4 + 1] = Math.random(); seeds[i * 4 + 2] = Math.random(); seeds[i * 4 + 3] = Math.random(); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    this.u = { uTime: { value: 0 }, uScore: { value: 0 }, uOn: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uR: { value: 0.12 },
      uColor: { value: new THREE.Color(accent) }, uCool: { value: new THREE.Color(0x7d8ba3) }, uPx: { value: 1 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      vertexShader: /* glsl */`
        attribute vec4 aSeed; uniform float uTime; uniform float uScore; uniform float uOn; uniform vec3 uCenter; uniform float uR; uniform float uPx;
        varying float vA; varying float vS;
        float h(float n){ return fract(sin(n) * 43758.5453); }
        void main() {
          float s = uScore;
          float lane = floor(aSeed.x * 3.0);                         // three orbital lanes
          float tilt = (lane - 1.0) * 0.32 + (aSeed.y - 0.5) * 0.25 * (1.0 - s);
          float speed = (0.10 + 0.22 * s) * (lane == 1.0 ? -1.0 : 1.0) * (0.8 + 0.4 * aSeed.z);
          float ang = aSeed.w * 6.2831853 + uTime * speed;
          float rad = uR * (1.55 + 0.35 * lane + (aSeed.z - 0.5) * mix(1.1, 0.12, s));
          vec3 p = vec3(cos(ang) * rad, 0.0, sin(ang) * rad);
          float ct = cos(tilt), st = sin(tilt);
          p = vec3(p.x, p.z * st, p.z * ct);
          // turbulence when the score is low
          float tt = uTime * 0.6 + aSeed.y * 40.0;
          vec3 j = vec3(sin(tt * 1.3 + aSeed.x * 9.0), sin(tt * 0.9 + aSeed.z * 7.0), cos(tt * 1.1 + aSeed.w * 5.0));
          p += j * uR * 0.35 * (1.0 - s);
          p.y += uR * (0.35 + 0.15 * sin(uTime * 0.5 + aSeed.x * 6.28));
          vec4 mv = modelViewMatrix * vec4(uCenter + p, 1.0);
          gl_Position = projectionMatrix * mv;
          float tw = 0.6 + 0.4 * sin(uTime * (2.0 + aSeed.z * 3.0) + aSeed.w * 30.0);
          vA = uOn * tw * mix(0.25, 1.0, s);
          vS = s;
          gl_PointSize = uPx * (2.0 + 4.5 * s * aSeed.z) * (1.0 / max(0.05, -mv.z));
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform vec3 uCool; varying float vA; varying float vS;
        void main() {
          vec2 d = gl_PointCoord - 0.5; float r = length(d);
          if (r > 0.5) discard;
          float a = smoothstep(0.5, 0.0, r);
          vec3 c = mix(uCool, uColor, smoothstep(0.2, 0.8, vS)) * mix(0.6, 2.2, vS);
          gl_FragColor = vec4(c * a * vA, a * vA);
        }`,
    });
    this.points = new THREE.Points(geo, mat); this.points.frustumCulled = false; this.points.renderOrder = 5;
    scene.add(this.points);
    this.on = 0; this.score = 0;
  }
  update(dt, t, { on, score, center, r, px }) {
    this.on += ((on ? 1 : 0) - this.on) * (1 - Math.exp(-dt / 0.6));
    this.score += (score - this.score) * (1 - Math.exp(-dt / 0.8));
    this.u.uOn.value = this.on; this.u.uScore.value = this.score; this.u.uTime.value = t;
    if (center) this.u.uCenter.value.copy(center);
    if (r) this.u.uR.value = r;
    this.u.uPx.value = px;
    this.points.visible = this.on > 0.01;
  }
  setAccent(c) { this.u.uColor.value.set(c); }
}

// ---------------------------------------------------------------- inter-brain arcs (duo)
export class BrainBridge {
  constructor(scene, accent) {
    this.scene = scene; this.accent = new THREE.Color(accent); this.links = new Map();
  }
  _make() {
    const geo = new LineGeometry(); geo.setPositions(new Float32Array(33 * 3));
    const mat = new LineMaterial({ color: this.accent.clone(), linewidth: 2, transparent: true, opacity: 0, depthWrite: false, dashed: true, dashSize: 0.02, gapSize: 0.012, blending: THREE.AdditiveBlending, toneMapped: false });
    const line = new Line2(geo, mat); line.frustumCulled = false; line.renderOrder = 4; this.scene.add(line);
    return { line, mat, geo, s: 0, pts: new Float32Array(33 * 3) };
  }
  update(dt, pairs, elA, elB, threshold, on, maxLinks = 6) {
    const seen = new Set();
    const top = (pairs || []).filter(p => p.r >= threshold).sort((a, b) => b.r - a.r).slice(0, maxLinks);
    for (const p of top) {
      const ea = elA.get(p.name), eb = elB.get(p.name);
      if (!ea || !eb || ea.idx < 0 || eb.idx < 0) continue;
      seen.add(p.name);
      let L = this.links.get(p.name); if (!L) this.links.set(p.name, (L = this._make()));
      L.target = on ? sstep(threshold, Math.min(1, threshold + 0.25), p.r) : 0;
      // bezier between the two electrodes, lifted above the heads
      const a = ea.wpos, b = eb.wpos, d = a.distanceTo(b);
      const cx = (a.x + b.x) / 2, cy = Math.max(a.y, b.y) + d * 0.45, cz = (a.z + b.z) / 2;
      for (let i = 0; i <= 32; i++) {
        const t = i / 32, u = 1 - t;
        L.pts[i * 3] = u * u * a.x + 2 * u * t * cx + t * t * b.x;
        L.pts[i * 3 + 1] = u * u * a.y + 2 * u * t * cy + t * t * b.y;
        L.pts[i * 3 + 2] = u * u * a.z + 2 * u * t * cz + t * t * b.z;
      }
      if (!L.init) { L.geo.setPositions(L.pts); L.line.computeLineDistances(); L.init = true; }
      else {                                                         // in place: no per-frame GPU buffer churn
        const ib = L.geo.attributes.instanceStart.data, arr = ib.array, P = L.pts;
        for (let i = 0; i < 32; i++) { const o = i * 6, s = i * 3; arr[o] = P[s]; arr[o + 1] = P[s + 1]; arr[o + 2] = P[s + 2]; arr[o + 3] = P[s + 3]; arr[o + 4] = P[s + 4]; arr[o + 5] = P[s + 5]; }
        ib.needsUpdate = true;
      }
    }
    for (const [name, L] of this.links) {
      if (!seen.has(name)) L.target = 0;
      L.s += ((L.target || 0) - L.s) * (1 - Math.exp(-dt / 0.4));
      L.line.visible = L.s > 0.01;
      L.mat.opacity = 0.7 * L.s; L.mat.linewidth = 0.8 + 1.6 * L.s;
      L.mat.color.copy(this.accent).multiplyScalar(0.6 + 0.6 * L.s);
      L.mat.dashOffset -= dt * 0.08;
    }
  }
  setAccent(c) { this.accent.set(c); }
  clear() { for (const L of this.links.values()) { this.scene.remove(L.line); L.geo.dispose(); L.mat.dispose(); } this.links.clear(); }
}
