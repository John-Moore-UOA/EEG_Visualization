// ===== AVATAR =====
// Load any rigged humanoid (Mixamo FBX, GLB/GLTF), normalise to metres, relax the T-pose, idle motion,
// stylised finishes, and a fitted 10-20 head frame + radial height map of the scalp.
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { vnoise } from './data.js';
import { REDUCED_MOTION } from './config.js';

// ---------------------------------------------------------------- loading
export function loadModel(src, onProgress) {
  // src: URL string or File
  const isFile = typeof src !== 'string';
  const name = isFile ? src.name : src.split('/').pop().split('?')[0];
  const url = isFile ? URL.createObjectURL(src) : src;
  const ext = name.toLowerCase().split('.').pop();
  return new Promise((resolve, reject) => {
    const done = obj => { if (isFile) URL.revokeObjectURL(url); resolve({ object: obj, name }); };
    const fail = e => { if (isFile) URL.revokeObjectURL(url); reject(e instanceof Error ? e : new Error(String(e && e.message || e))); };
    if (ext === 'fbx') new FBXLoader().load(url, done, onProgress, fail);
    else if (ext === 'glb' || ext === 'gltf') new GLTFLoader().load(url, g => done(g.scene), onProgress, fail);
    else fail(new Error(`Unsupported file type ".${ext}" (use .fbx, .glb or .gltf)`));
  });
}

const findBone = (bones, suffix) => bones.find(b => new RegExp(`(^|[^A-Za-z])${suffix}$`).test(b.name) || b.name === suffix) || null;

// ---------------------------------------------------------------- finishes
// Every finish is a MeshStandardMaterial with an injected fresnel rim; 'hologram' also fades the body and adds scanlines.
function rimify(mat, { rim = '#9aa6b5', power = 3.0, strength = 0.35, holo = false } = {}) {
  mat.userData.u = { uRim: { value: new THREE.Color(rim) }, uRimPow: { value: power }, uRimStr: { value: strength }, uTime: { value: 0 } };
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, mat.userData.u);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRim; uniform float uRimPow; uniform float uRimStr; uniform float uTime;')
      .replace('#include <opaque_fragment>', `
        float fres = pow(1.0 - saturate(dot(normalize(normal), normalize(vViewPosition))), uRimPow);
        outgoingLight += uRim * fres * uRimStr;
        ${holo ? `
        float scan = 0.55 + 0.45 * sin(gl_FragCoord.y * 1.2 + uTime * 6.0);
        diffuseColor.a = clamp(0.05 + fres * 0.9, 0.0, 1.0) * mix(0.75, 1.0, scan);
        outgoingLight = uRim * (0.25 + 1.2 * fres) * mix(0.8, 1.0, scan);` : ''}
        #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'rim' + (holo ? 'h' : '');
  return mat;
}
export const FINISHES = {
  graphite:  { label: 'Graphite', make: () => rimify(new THREE.MeshStandardMaterial({ color: 0x1e232a, roughness: 0.58, metalness: 0.15 }), { rim: '#8e9aab', power: 2.6, strength: 0.45 }) },
  porcelain: { label: 'Porcelain', make: () => rimify(new THREE.MeshStandardMaterial({ color: 0xd9d5cd, roughness: 0.42, metalness: 0.0 }), { rim: '#ffffff', power: 3.0, strength: 0.18 }) },
  skin:      { label: 'Original', make: orig => { const o = [].concat(orig)[0] || {}; return rimify(new THREE.MeshStandardMaterial({ map: o.map || null, normalMap: o.normalMap || null, color: o.map ? 0xffffff : 0xb08a74, roughness: 0.68, metalness: 0 }), { rim: '#ffd9c0', power: 3.5, strength: 0.12 }); } },
  hologram:  { label: 'Hologram', make: () => rimify(new THREE.MeshStandardMaterial({ color: 0x000000, transparent: true, depthWrite: false, side: THREE.FrontSide }), { rim: '#7fd6ff', power: 2.2, strength: 1, holo: true }) },
};

// ---------------------------------------------------------------- Avatar
export class Avatar {
  constructor(object, name) {
    this.name = name;
    this.root = new THREE.Group(); this.root.name = 'avatarRoot';
    this.model = object;
    this.root.add(object);
    this.meshes = []; this.origMats = new Map();
    object.traverse(o => {
      if (o.isMesh) { this.meshes.push(o); this.origMats.set(o, o.material); o.frustumCulled = false; o.castShadow = false; o.receiveShadow = false; }
    });
    // normalise: metres, feet on the floor, centred
    object.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(object);
    const h = box.max.y - box.min.y;
    const s = h >= 100 && h <= 250 ? 0.01 : h >= 1 && h <= 2.5 ? 1 : 1.75 / h;   // cm (Mixamo) | metres | anything else
    object.scale.multiplyScalar(s);
    object.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(object);
    object.position.x -= (box.min.x + box.max.x) / 2; object.position.z -= (box.min.z + box.max.z) / 2; object.position.y -= box.min.y;
    object.updateMatrixWorld(true);
    this.height = box.max.y - box.min.y;

    const sk = this.meshes.find(m => m.isSkinnedMesh);
    this.skinned = sk || null;
    this.bones = sk ? sk.skeleton.bones : [];
    const B = sfx => findBone(this.bones, sfx);
    this.b = { head: B('Head'), neck: B('Neck'), spine: B('Spine'), spine1: B('Spine1'), spine2: B('Spine2'),
      lArm: B('LeftArm'), lFore: B('LeftForeArm'), lHand: B('LeftHand'), rArm: B('RightArm'), rFore: B('RightForeArm'), rHand: B('RightHand'),
      lSh: B('LeftShoulder'), rSh: B('RightShoulder') };
    this._relaxArms();
    this.rest = new Map(this.bones.map(b => [b, b.quaternion.clone()]));
    this.finish = null;
  }
  clone() {
    // the head-frame groups (cap, electrodes, labels) hang off bones; keep them out of the copy
    const extras = []; this.model.traverse(o => { if (o.name === 'headFrame') extras.push([o, o.parent]); });
    extras.forEach(([o, p]) => p.remove(o));
    let obj;
    try { obj = SkeletonUtils.clone(this.model); } finally { extras.forEach(([o, p]) => p.add(o)); }
    const a = Object.create(Avatar.prototype);
    a.name = this.name; a.root = new THREE.Group(); a.model = obj; a.root.add(obj);
    a.meshes = []; a.origMats = new Map();
    obj.traverse(o => { if (o.isMesh) { a.meshes.push(o); o.frustumCulled = false; } });
    a.meshes.forEach((m, i) => a.origMats.set(m, this.origMats.get(this.meshes[i])));
    a.height = this.height;
    const sk = a.meshes.find(m => m.isSkinnedMesh); a.skinned = sk || null; a.bones = sk ? sk.skeleton.bones : [];
    const B = sfx => findBone(a.bones, sfx);
    a.b = { head: B('Head'), neck: B('Neck'), spine: B('Spine'), spine1: B('Spine1'), spine2: B('Spine2'), lArm: B('LeftArm'), lFore: B('LeftForeArm'), lHand: B('LeftHand'), rArm: B('RightArm'), rFore: B('RightForeArm'), rHand: B('RightHand'), lSh: B('LeftShoulder'), rSh: B('RightShoulder') };
    a.rest = new Map(a.bones.map(b => [b, b.quaternion.clone()]));
    a.finish = null; a.phase = Math.random() * 100;
    return a;
  }
  // Aim a bone (in world space) so its child points along dir. Generic across rigs: no assumption about local axes.
  _aim(bone, child, dir) {
    if (!bone || !child || !bone.parent) return;
    this.root.updateMatrixWorld(true);
    const bp = bone.getWorldPosition(new THREE.Vector3()), cp = child.getWorldPosition(new THREE.Vector3());
    const cur = cp.sub(bp).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(cur, dir.clone().normalize());
    const wq = bone.getWorldQuaternion(new THREE.Quaternion()), pq = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    bone.quaternion.copy(pq.invert().multiply(q.multiply(wq)));
    bone.updateMatrixWorld(true);
  }
  _relaxArms() {
    const b = this.b;
    if (!b.lArm || !b.rArm) return;
    // only relax if the arms are roughly horizontal (T/A pose)
    this.root.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    const dirOf = (x, y) => y.getWorldPosition(v.clone()).sub(x.getWorldPosition(new THREE.Vector3())).normalize();
    if (b.lFore && dirOf(b.lArm, b.lFore).y < -0.8) return;
    this._aim(b.lArm, b.lFore, new THREE.Vector3(0.2, -1, 0.02));
    this._aim(b.rArm, b.rFore, new THREE.Vector3(-0.2, -1, 0.02));
    this._aim(b.lFore, b.lHand, new THREE.Vector3(0.08, -1, 0.22));
    this._aim(b.rFore, b.rHand, new THREE.Vector3(-0.08, -1, 0.22));
  }
  setFinish(key) {
    if (this.finish === key) return;
    this.finish = key;
    for (const m of this.meshes) {
      const nm = FINISHES[key].make(this.origMats.get(m));
      if (m.material && m.material !== this.origMats.get(m)) [].concat(m.material).forEach(x => x.dispose && x.dispose());
      m.material = nm; m.renderOrder = key === 'hologram' ? 1 : 0;
    }
  }
  // breathing + gentle head drift (relative to the relaxed rest pose)
  idle(t, amount = 1) {
    if (REDUCED_MOTION) amount *= 0.2;
    const ph = this.phase || 0, tt = t + ph;
    const set = (bone, x, y, z) => { if (!bone) return; _e.set(x * amount, y * amount, z * amount); _q.setFromEuler(_e); bone.quaternion.copy(this.rest.get(bone)).multiply(_q); };
    const br = Math.sin(tt * 2 * Math.PI * 0.21);
    set(this.b.spine1, 0.010 * br, 0, 0);
    set(this.b.spine2, 0.014 * br, 0, 0);
    set(this.b.lSh, 0, 0, 0.012 * br); set(this.b.rSh, 0, 0, -0.012 * br);
    const yaw = 0.09 * vnoise(11 + ph, tt * 0.09) + 0.03 * vnoise(17 + ph, tt * 0.31);
    const pitch = 0.04 * vnoise(23 + ph, tt * 0.07) - 0.012 * br;
    const roll = 0.025 * vnoise(29 + ph, tt * 0.06);
    set(this.b.neck, pitch * 0.4, yaw * 0.4, roll * 0.4);
    set(this.b.head, pitch * 0.6, yaw * 0.6, roll * 0.6);
    for (const m of this.meshes) { const mt = [].concat(m.material); for (const x of mt) if (x.userData.u) x.userData.u.uTime.value = t; }
  }
  resetPose() { for (const [b, q] of this.rest) b.quaternion.copy(q); this.root.updateMatrixWorld(true); }

  // ------------------------------------------------------------ head sampling
  // Dense point cloud of the head surface, stored in HEAD-BONE local space (so it survives refits and follows the bone).
  sampleHead() {
    // sample in the avatar's own frame (root at the origin, unrotated) so the head frame axes are the avatar's axes
    const saved = { p: this.root.position.clone(), q: this.root.quaternion.clone(), s: this.root.scale.clone(), parent: this.root.parent };
    if (saved.parent) saved.parent.remove(this.root);
    this.root.position.set(0, 0, 0); this.root.quaternion.identity(); this.root.scale.set(1, 1, 1);
    try { return this._sampleHead(); }
    finally {
      this.root.position.copy(saved.p); this.root.quaternion.copy(saved.q); this.root.scale.copy(saved.s);
      if (saved.parent) saved.parent.add(this.root);
      this.root.updateMatrixWorld(true);
    }
  }
  _sampleHead() {
    this.resetPose();
    const head = this.b.head, mesh = this.skinned || this.meshes[0];
    const geo = mesh.geometry, P = geo.attributes.position, n = P.count;
    const SI = geo.attributes.skinIndex, SW = geo.attributes.skinWeight;
    // which bones count as "head": the head bone and all its descendants
    const headSet = new Set();
    if (head && this.skinned) head.traverse(o => { const i = this.bones.indexOf(o); if (i >= 0) headSet.add(i); });
    const world = new Float32Array(n * 3), isHead = new Uint8Array(n), v = new THREE.Vector3();
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
      world[i * 3] = v.x; world[i * 3 + 1] = v.y; world[i * 3 + 2] = v.z;
      if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
    }
    if (headSet.size && SI) {
      for (let i = 0; i < n; i++) { let w = 0; for (let k = 0; k < 4; k++) if (headSet.has(SI.getComponent(i, k))) w += SW.getComponent(i, k); if (w > 0.5) isHead[i] = 1; }
    } else {
      const cut = maxY - (maxY - minY) * 0.12;                     // fallback: top 12% of the model
      for (let i = 0; i < n; i++) if (world[i * 3 + 1] > cut) isHead[i] = 1;
    }
    // triangles fully inside the head region -> barycentric densification
    const idx = geo.index ? geo.index.array : null, triCount = idx ? idx.length / 3 : n / 3;
    const pts = [];
    const A = new THREE.Vector3(), Bv = new THREE.Vector3(), C = new THREE.Vector3();
    for (let t = 0; t < triCount; t++) {
      const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
      if (!isHead[a] || !isHead[b] || !isHead[c]) continue;
      A.fromArray(world, a * 3); Bv.fromArray(world, b * 3); C.fromArray(world, c * 3);
      const e = Math.max(A.distanceTo(Bv), Bv.distanceTo(C), C.distanceTo(A));
      const k = Math.min(12, Math.max(1, Math.ceil(e / 0.0025)));
      for (let i = 0; i <= k; i++) for (let j = 0; j <= k - i; j++) {
        const u = i / k, w = j / k, z = 1 - u - w;
        pts.push(A.x * z + Bv.x * u + C.x * w, A.y * z + Bv.y * u + C.y * w, A.z * z + Bv.z * u + C.z * w);
      }
    }
    const cloud = new Float32Array(pts);
    const box = new THREE.Box3(); for (let i = 0; i < cloud.length; i += 3) box.expandByPoint(v.fromArray(cloud, i));
    // to head-bone local space
    const bone = head || this.root;
    bone.updateWorldMatrix(true, false);
    this.boneBind = bone.matrixWorld.clone();
    const inv = this.boneBind.clone().invert();
    for (let i = 0; i < cloud.length; i += 3) { v.fromArray(cloud, i).applyMatrix4(inv); cloud[i] = v.x; cloud[i + 1] = v.y; cloud[i + 2] = v.z; }
    this.headCloud = cloud; this.headBoxWorld = box; this.headBone = bone;
    return { cloud, box };
  }
}
const _e = new THREE.Euler(), _q = new THREE.Quaternion();

// ---------------------------------------------------------------- head frame + height map
// The head frame: origin = 10-20 sphere centre, axes = avatar's world axes (+Y up, +Z nose, +X subject left), metres.
// Returned matrices: frameToBone (put the cap group under the head bone with this matrix).
export function fitHeadFrame(av, fit = { up: 0, fwd: 0, tilt: 0, size: 1 }) {
  const box = av.headBoxWorld, bone = av.headBone;
  const rx = (box.max.x - box.min.x) / 2, rz = (box.max.z - box.min.z) / 2;
  const ry = rz * 0.98;
  const r = (rx + ry + rz) / 3;
  const c = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y - ry + fit.up * r, (box.min.z + box.max.z) / 2 - 0.06 * rz + fit.fwd * r);
  const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(fit.tilt * Math.PI / 180, 0, 0));
  const frameWorld = new THREE.Matrix4().compose(c, rot, new THREE.Vector3(1, 1, 1));
  const frameToBone = av.boneBind.clone().invert().multiply(frameWorld);
  // cloud -> frame space
  const boneToFrame = frameToBone.clone().invert();
  const cloud = av.headCloud, n = cloud.length / 3, v = new THREE.Vector3();
  const H = new HeightMap(96, 192);
  for (let i = 0; i < n; i++) { v.fromArray(cloud, i * 3).applyMatrix4(boneToFrame); H.add(v.x, v.y, v.z); }
  H.finish();
  return { frameToBone, radii: new THREE.Vector3(rx * fit.size, ry * fit.size, rz * fit.size), r, heights: H, centreWorld: c };
}

// Radial height map R(theta, phi) of the outermost surface around the frame origin.
export class HeightMap {
  constructor(nt, np) { this.nt = nt; this.np = np; this.R = new Float32Array(nt * np); }
  _ij(x, y, z) {
    const l = Math.hypot(x, y, z) || 1e-9;
    const th = Math.acos(Math.max(-1, Math.min(1, y / l))), ph = Math.atan2(x, z);
    return [Math.min(this.nt - 1, Math.floor(th / Math.PI * this.nt)), ((Math.floor((ph + Math.PI) / (2 * Math.PI) * this.np) % this.np) + this.np) % this.np, l];
  }
  add(x, y, z) { const [i, j, l] = this._ij(x, y, z), k = i * this.np + j; if (l > this.R[k]) this.R[k] = l; }
  finish() {
    const { nt, np } = this; let R = this.R;
    // fill holes by iterative neighbour averaging, then 2 passes of 3x3 smoothing
    for (let it = 0; it < 80; it++) {
      let holes = 0; const O = R.slice();
      for (let i = 0; i < nt; i++) for (let j = 0; j < np; j++) {
        const k = i * np + j; if (R[k] > 0) continue;
        let s = 0, c = 0;
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { const ii = i + di; if (ii < 0 || ii >= nt) continue; const v = R[ii * np + (j + dj + np) % np]; if (v > 0) { s += v; c++; } }
        if (c) O[k] = s / c; else holes++;
      }
      R = O; if (!holes) break;
    }
    for (let pass = 0; pass < 2; pass++) {
      const O = R.slice();
      for (let i = 1; i < nt - 1; i++) for (let j = 0; j < np; j++) {
        let s = 0; for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) s += R[(i + di) * np + (j + dj + np) % np];
        O[i * np + j] = s / 9;
      }
      R = O;
    }
    this.R = R;
  }
  // bilinear sample along a (not necessarily unit) direction
  sample(x, y, z) {
    const l = Math.hypot(x, y, z) || 1e-9;
    const th = Math.acos(Math.max(-1, Math.min(1, y / l))), ph = Math.atan2(x, z);
    const fi = th / Math.PI * this.nt - 0.5, fj = (ph + Math.PI) / (2 * Math.PI) * this.np - 0.5;
    const i0 = Math.max(0, Math.min(this.nt - 1, Math.floor(fi))), i1 = Math.min(this.nt - 1, i0 + 1), ti = Math.min(1, Math.max(0, fi - i0));
    const j0 = Math.floor(fj), tj = fj - j0, a = (j0 % this.np + this.np) % this.np, b = (a + 1) % this.np, np = this.np, R = this.R;
    return (R[i0 * np + a] * (1 - tj) + R[i0 * np + b] * tj) * (1 - ti) + (R[i1 * np + a] * (1 - tj) + R[i1 * np + b] * tj) * ti;
  }
}
