// ===== DATA LAYER =====
// Frame (raw, un-normalised) = { t, units: 'uV^2' | 'relative' | string, bands: { [band]: { [channel]: number } } }
// DataSource: start(), stop(), onFrame(cb), onStatus(cb), state in 'idle'|'mock'|'connecting'|'live'|'stale'|'disconnected'
import { BANDS, CONFIG, PARAMS, montageFor, montageChannels } from './config.js';

export class DataSource {
  constructor() { this._frameCbs = []; this._statusCbs = []; this._state = 'idle'; this._info = {}; }
  start() {}
  stop() {}
  get state() { return this._state; }
  get info() { return this._info; }
  onFrame(cb) { this._frameCbs.push(cb); return () => { this._frameCbs = this._frameCbs.filter(f => f !== cb); }; }
  onStatus(cb) { this._statusCbs.push(cb); cb(this._state, this._info); return () => { this._statusCbs = this._statusCbs.filter(f => f !== cb); }; }
  _emitFrame(frame) { for (const cb of this._frameCbs) cb(frame); }
  _setStatus(state, info = {}) { this._state = state; this._info = info; for (const cb of this._statusCbs) cb(state, info); }
}

// ---- deterministic smooth noise ----
function hash01(seed, i) {
  let h = Math.imul(seed ^ Math.imul(i, 374761393), 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function vnoise(seed, x) { // smooth 1-D value noise in [-1, 1]
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return (hash01(seed, i) * (1 - u) + hash01(seed, i + 1) * u) * 2 - 1;
}
const fbm3 = (seed, t) => 0.6 * vnoise(seed, t * 0.07) + 0.3 * vnoise(seed + 101, t * 0.19) + 0.1 * vnoise(seed + 202, t * 0.47);
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// ---- simulated brain states: per band x region multipliers ----
export const SIM_STATES = ['rest', 'focus', 'relax', 'drowsy'];
export const SIM_LABEL = { auto: 'Auto', rest: 'Rest', focus: 'Focus', relax: 'Relax', drowsy: 'Drowsy' };
function regionOf(name) {
  const n = name.toLowerCase();
  if (/^fp/.test(n)) return 'Fp';
  if (/^f/.test(n)) return 'F';
  if (/^c/.test(n)) return 'C';
  if (/^t/.test(n)) return 'T';
  if (/^p/.test(n)) return 'P';
  if (/^o/.test(n)) return 'O';
  return 'C';
}
const STATE_MUL = {
  rest: () => 1,
  focus: (band, r, n) => ({
    delta: 0.9,
    theta: /^(fz|f3|f4)$/.test(n) ? 1.35 : 0.85,
    alpha: r === 'O' || r === 'P' ? 0.55 : 0.7,
    beta: r === 'F' || r === 'C' || r === 'Fp' ? 1.85 : 1.4,
    gamma: 1.2,
  })[band],
  relax: (band, r) => ({
    delta: 0.95,
    theta: 1.05,
    alpha: { O: 2.6, P: 2.1, C: 1.5, T: 1.3, F: 1.2, Fp: 1.1 }[r],
    beta: 0.7,
    gamma: 0.8,
  })[band],
  drowsy: (band, r) => ({
    delta: 1.5,
    theta: r === 'F' || r === 'C' || r === 'Fp' ? 2.0 : 1.7,
    alpha: r === 'F' || r === 'Fp' ? 1.15 : 0.75,      // alpha "anteriorises" as vigilance drops
    beta: 0.65,
    gamma: 0.75,
  })[band],
};

// A drive shared by several MockSources (duo mode): common clock + common latent noise + slowly varying coupling.
export class SharedDrive {
  constructor(seed = 77) { this.seed = seed; this.t0 = performance.now() / 1000; }
  t() { return performance.now() / 1000 - this.t0; }
  coupling(t) { // 0..1, episodes of strong inter-brain synchrony every ~30-60 s
    const s = 0.5 + 0.5 * (0.75 * vnoise(this.seed + 5, t * 0.03) + 0.25 * vnoise(this.seed + 9, t * 0.11));
    return Math.min(1, Math.max(0, (s - 0.25) * 1.6));
  }
  lat(bi, k, t) { return 0.7 * vnoise(this.seed * 31 + bi * 31 + k * 7, t * 0.05) + 0.3 * vnoise(this.seed * 31 + 500 + bi * 31 + k * 7, t * 0.13); }
  net(k, t) { return vnoise(this.seed * 17 + 40 + k, t * 0.35); }
  // per-channel noise keyed by channel NAME, so homologous electrodes of two subjects can share it
  chan(key, bi, t) { return 0.6 * vnoise(this.seed * 991 + key * 13 + bi * 7, t * 0.07) + 0.4 * vnoise(this.seed * 991 + 300 + key * 13 + bi * 7, t * 0.19); }
  chanFast(key, bi, t) { return vnoise(this.seed * 577 + key * 17 + bi * 5, t * 0.6); }
}

// ---- Mock: spatially correlated noise + simulated states + networks + artefacts ----
export class MockSource extends DataSource {
  constructor({ channels, seed = 0, shared = null, rateHz = CONFIG.rateHz } = {}) {
    super();
    this.kind = 'mock';
    this.channels = channels || montageChannels(19);
    this.seed = seed; this.shared = shared; this.rateHz = rateHz;
    this.base = { delta: 15, theta: 8, alpha: 12, beta: 3.5, gamma: 0.6 };
    this.target = 'auto'; this.simState = 'rest';
    this.w = { rest: 1, focus: 0, relax: 0, drowsy: 0 };
    const latent = [[0, 0.3, 0.95], [0, 0.3, -0.95], [0.95, 0.3, 0], [-0.95, 0.3, 0], [0, 1, 0]].map(v => { const n = Math.hypot(...v); return v.map(c => c / n); });
    this.chan = this.channels.map((name, ci) => {
      const m = montageFor(name), dir = m ? m.dir : [0, 1, 0], n = name.toLowerCase();
      const w = latent.map(l => { const ang = Math.acos(Math.max(-1, Math.min(1, dir[0] * l[0] + dir[1] * l[1] + dir[2] * l[2]))); return Math.exp(-((ang / 0.75) ** 2)); });
      const ws = w.reduce((a, b) => a + b, 0) || 1;
      return {
        name, n, region: regionOf(name), w: w.map(x => x / ws), seed: 1000 + seed * 7919 + ci * 97, key: [...n].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 9973,
        fp: /^(fz|f3|f4|p3|p4|pz)$/.test(n),                   // fronto-parietal (focus network)
        pa: /^(o1|o2|p3|p4|pz|p7|p8)$/.test(n),                // posterior alpha (relax network)
        faa: /^(f3|f7|fp1)$/.test(n) ? -1 : /^(f4|f8|fp2)$/.test(n) ? 1 : 0,
      };
    });
  }
  setTarget(s) { this.target = s; if (s !== 'auto') this._autoUntil = 0; }
  start() {
    this.stop();
    this._t0 = performance.now() / 1000;
    this._last = null;
    this._autoUntil = 8; this._autoState = 'rest';
    this._nextBlink = 2 + Math.random() * 3; this._blinkAt = -10;
    this._nextLoose = 25 + Math.random() * 20; this._loose = null;
    this._running = true;
    this._setStatus('mock', { channels: this.channels.length });
    const tick = () => {
      if (!this._running) return;
      this._emitFrame(this._frame());
      this._timer = setTimeout(tick, 1000 / this.rateHz + (Math.random() * 12 - 6));
    };
    tick();
  }
  stop() { this._running = false; clearTimeout(this._timer); }
  _t() { return this.shared ? this.shared.t() : performance.now() / 1000 - this._t0; }
  _frame() {
    const t = this._t(), dt = this._last === null ? 0.1 : Math.min(1, Math.max(0, t - this._last)); this._last = t;
    // ---- state machine ----
    if (this.target === 'auto') {
      if (t >= this._autoUntil) {
        const opts = ['rest', 'focus', 'relax', 'drowsy'].filter(s => s !== this._autoState);
        this._autoState = opts[Math.floor(Math.random() * opts.length)];
        this._autoUntil = t + 14 + Math.random() * 12;
      }
      this.simState = this._autoState;
    } else this.simState = this.target;
    const k = 1 - Math.exp(-dt / 2.5);
    for (const s of Object.keys(this.w)) this.w[s] += ((s === this.simState ? 1 : 0) - this.w[s]) * k;
    // ---- artefacts ----
    if (t >= this._nextBlink) { this._blinkAt = t; this._nextBlink = t + (this.simState === 'drowsy' ? 2.5 : 4) + Math.random() * 3; }
    const bu = (t - this._blinkAt) / 0.3, blink = bu >= 0 && bu <= 1 ? Math.sin(Math.PI * bu) : 0;
    if (!this._loose && t >= this._nextLoose) this._loose = { ch: Math.floor(Math.random() * this.chan.length), until: t + 6 + Math.random() * 6 };
    if (this._loose && t > this._loose.until) { this._loose = null; this._nextLoose = t + 35 + Math.random() * 35; }
    // ---- couplings ----
    const sh = this.shared, c = sh ? sh.coupling(t) : 0;
    const own = (bi, kk) => 0.7 * vnoise(9000 + this.seed * 131 + bi * 31 + kk * 7, t * 0.05) + 0.3 * vnoise(9500 + this.seed * 131 + bi * 31 + kk * 7, t * 0.13);
    const netOwn = kk => vnoise(7000 + this.seed * 53 + kk, t * 0.35);
    const net = kk => (sh ? netOwn(kk) * (1 - c) + sh.net(kk, t) * c : netOwn(kk));
    const nFP = net(0), nPA = net(1), nSMR = net(2);
    const faa = 0.28 * vnoise(4242 + this.seed, t * 0.04);
    const W = this.w;

    const bands = {};
    BANDS.forEach((band, bi) => {
      const out = {};
      const lat = [0, 1, 2, 3, 4].map(kk => (sh ? own(bi, kk) * (1 - c) + sh.lat(bi, kk, t) * c : own(bi, kk)));
      for (let ci = 0; ci < this.chan.length; ci++) {
        const ch = this.chan[ci];
        let shared = 0; for (let kk = 0; kk < 5; kk++) shared += ch.w[kk] * lat[kk];
        let o = fbm3(ch.seed + bi * 13, t), of = vnoise(ch.seed + bi * 13 + 555, t * 0.6);
        if (sh) { o = o * (1 - c) + sh.chan(ch.key, bi, t) * c; of = of * (1 - c) + sh.chanFast(ch.key, bi, t) * c; }
        let mul = 0;
        for (const s of SIM_STATES) if (W[s] > 1e-3) mul += W[s] * STATE_MUL[s](band, ch.region, ch.n);
        // slow spatial field + own slow/fast noise + Welch-like estimation jitter
        let v = this.base[band] * this._prior(band, ch.n) * mul * (1 + 0.3 * (0.55 * o + 0.5 * of + 0.6 * shared)) * Math.exp(0.09 * gauss());
        // state-dependent networks: these are what the envelope-correlation arcs should reveal
        if (band === 'beta' && ch.fp) v *= 1 + (0.1 + 0.68 * W.focus) * nFP;
        if (band === 'alpha' && ch.pa) v *= 1 + (0.1 + 0.72 * W.relax) * nPA;
        if (band === 'beta' && ch.region === 'C') v *= 1 + 0.18 * nSMR;
        if (band === 'alpha' && ch.faa) v *= Math.exp(ch.faa * faa);
        if (band === 'delta' && ch.region === 'Fp') v *= 1 + 2.2 * blink;
        if (band === 'delta' && ch.region === 'F') v *= 1 + 0.6 * blink;
        if (this._loose && this._loose.ch === ci) v *= Math.exp(0.9 * gauss()) * (band === 'gamma' ? 4 : band === 'delta' ? 2.5 : 1.3);
        out[ch.name] = Math.max(0.05 * this.base[band], v);
      }
      bands[band] = out;
    });
    return { t: Date.now() / 1000, units: 'uV^2', bands };
  }
  _prior(band, n) {
    const isF = /^(fp|f)\d|^fz$/.test(n), isFp = /^fp/.test(n);
    switch (band) {
      case 'alpha': if (/^o\d/.test(n)) return 2.0; if (/^p\d|^pz$/.test(n)) return 1.5; if (isF) return 0.6; return 1;
      case 'theta': return /^(f3|f4|fz)$/.test(n) ? 1.4 : 1;
      case 'beta': return /^(c3|c4|cz)$/.test(n) ? 1.3 : 1;
      case 'delta': return isFp ? 1.7 : 1;
      case 'gamma': return /^(t7|t8|f7|f8)$/.test(n) ? 1.5 : 1;
    }
    return 1;
  }
}

// ---- Wire parsing: matches bridge.py ----
function canonicalName(k) { const m = montageFor(k); return m ? m.name : String(k).trim(); }
function cleanValues(obj) {
  const out = {}; let n = 0;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  for (const k of Object.keys(obj)) { const v = obj[k]; if (typeof v === 'number' && Number.isFinite(v)) { out[canonicalName(k)] = v; n++; } }
  return n ? out : null;
}
export function parseMessage(text, flatBand) {
  let msg;
  try { msg = JSON.parse(text.replace(/NaN|-?Infinity/g, 'null')); } catch { return null; }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const t = Number.isFinite(msg.t) ? msg.t : Date.now() / 1000;
  const units = typeof msg.units === 'string' ? msg.units : 'uV^2';
  if (msg.type === 'bandpower' || (msg.bands && typeof msg.bands === 'object')) {
    const bands = {}; let any = false;
    for (const b of BANDS) { const v = cleanValues(msg.bands && msg.bands[b]); if (v) { bands[b] = v; any = true; } }
    return any ? { t, units, bands } : null;
  }
  if (typeof msg.band === 'string' && BANDS.includes(msg.band.toLowerCase())) {
    const v = cleanValues(msg.values);
    return v ? { t, units, bands: { [msg.band.toLowerCase()]: v } } : null;
  }
  const v = cleanValues(msg);
  if (!v) return null;
  delete v.t;
  return Object.keys(v).length ? { t, units, bands: { [flatBand()]: v }, flat: true } : null;
}

// ---- WebSocket: auto-reconnect with backoff, stale detection, never falls back to mock ----
export class WebSocketSource extends DataSource {
  constructor({ url = CONFIG.wsDefaultUrl, flatBand = () => CONFIG.defaultBand } = {}) {
    super();
    this.kind = 'ws';
    this.url = url; this.flatBand = flatBand; this.boundFlatBand = BANDS.includes(PARAMS.get('flatBand')) ? PARAMS.get('flatBand') : null;
    this.rate = 0; this.lastFrameAt = 0; this.badMessages = 0;
  }
  start() { this._stopped = false; this._attempt = 0; this.lastFrameAt = 0; this._connect(); this._watch = setInterval(() => this._checkStale(), 250); }
  stop() {
    this._stopped = true;
    clearTimeout(this._retry); clearInterval(this._watch);
    const ws = this.ws; this.ws = null;
    if (ws) {
      ws.onmessage = ws.onerror = ws.onclose = null;
      if (ws.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close(); else { ws.onopen = null; ws.close(); }
    }
    this._setStatus('disconnected', { reason: 'stopped', lastFrameAt: this.lastFrameAt });
  }
  _connect() {
    if (this._stopped) return;
    let ws;
    try {
      if (!/^wss?:\/\//i.test(this.url)) throw new Error('URL must start with ws:// or wss://');
      ws = new WebSocket(this.url);
    } catch { this._setStatus('disconnected', { reason: 'invalid URL', lastFrameAt: this.lastFrameAt }); return; }
    this.ws = ws;
    this._setStatus('connecting', { url: this.url, open: false, attempt: this._attempt });
    ws.onopen = () => this._setStatus('connecting', { url: this.url, open: true });
    ws.onmessage = ev => {
      if (typeof ev.data !== 'string') return;
      const frame = parseMessage(ev.data, () => (this.boundFlatBand = this.boundFlatBand || this.flatBand()));
      if (!frame) { if (this.badMessages++ === 0) console.info('[ws] ignored a message that is not a recognised band-power shape'); return; }
      const now = performance.now(), at = this._arrivals || (this._arrivals = []);
      at.push(now); while (at.length && now - at[0] > 2000) at.shift();
      this.rate = at.length > 2 ? (at.length - 1) * 1000 / Math.max(1, now - at[0]) : 0;
      this.lastFrameAt = now; this._attempt = 0;
      if (this._state !== 'live') this._setStatus('live', { url: this.url });
      this._emitFrame(frame);
    };
    ws.onerror = () => {};
    ws.onclose = () => this._scheduleRetry();
  }
  _scheduleRetry() {
    this.ws = null; this._arrivals = [];
    if (this._stopped) return;
    const d = CONFIG.backoffSec[Math.min(this._attempt, CONFIG.backoffSec.length - 1)];
    this._attempt++;
    this._setStatus('disconnected', { retryAt: performance.now() + d * 1000, lastFrameAt: this.lastFrameAt });
    this._retry = setTimeout(() => this._connect(), d * 1000);
  }
  _checkStale() {
    const quiet = performance.now() - this.lastFrameAt;
    if (this._state === 'live' && quiet > CONFIG.staleMs) this._setStatus('stale', { lastFrameAt: this.lastFrameAt });
    if (this._state === 'stale' && quiet > CONFIG.staleReconnectMs && this.ws) {
      const ws = this.ws; ws.onmessage = ws.onerror = ws.onclose = ws.onopen = null; ws.close();
      this._scheduleRetry();
    }
  }
}

/* SWAP-TO-LIVE POINT
 *   Mock (default):  studio/index.html
 *   Live (LSL):      python bridge.py   then   studio/index.html?source=ws&url=ws://localhost:8765
 * Any other transport: subclass DataSource, emit {t, units, bands:{band:{channel:value}}}. */
export function createSource({ kind, url, montage = 19, seed = 0, shared = null, flatBand } = {}) {
  kind = kind || ((PARAMS.get('source') === 'ws' || PARAMS.has('ws')) ? 'ws' : 'mock');
  if (kind === 'ws') return new WebSocketSource({ url: url || PARAMS.get('url') || PARAMS.get('ws') || CONFIG.wsDefaultUrl, flatBand });
  return new MockSource({ channels: montageChannels(montage), seed, shared });
}
