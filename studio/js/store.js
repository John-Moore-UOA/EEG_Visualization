// ===== NORMALISATION + ANALYTICS =====
// BandPowerStore: raw values in, per-band adaptive normalised values out (2nd-98th pct over 20 s).
// Analytics: derived metrics, baseline (dB change), envelope correlation, signal quality, spectrum estimate.
import { BANDS, BAND_INFO, CONFIG, montageFor } from './config.js';

export class BandPowerStore {
  constructor() { this.version = 0; this._ingestCbs = []; this.locked = false; this.reset(); }
  reset() {
    this.records = new Map(); this.list = []; this.units = null; this.frames = 0; this.lastIngest = 0;
    this.ranges = BANDS.map(() => ({ lo: 0, hi: 1, tlo: 0, thi: 1, init: false, clip: NaN, fmax: -Infinity }));
    this._win = BANDS.map(() => []);
    this._lastRangeAt = 0;
    this.version++;
  }
  onIngest(cb) { this._ingestCbs.push(cb); }
  channels() { return this.list; }
  record(name) { return this.records.get(name) || null; }
  hasBand(b) { const bi = BANDS.indexOf(b); for (const r of this.list) if (r.has[bi] && !r.stale) return true; return false; }
  range(band) { const r = this.ranges[BANDS.indexOf(band)]; return { lo: r.lo, hi: r.hi, clip: r.clip }; }
  // last n raw values of one channel/band, oldest -> newest, into out (Float32Array) ; returns count
  tail(r, bi, n, out) {
    const h = r.hist[bi], c = Math.min(n, h.count), L = h.buf.length;
    for (let i = 0; i < c; i++) out[i] = h.buf[(h.head - c + i + L) % L];
    return c;
  }
  _newRecord(name) {
    return { name, m: montageFor(name), raw: new Float64Array(5), norm: new Float32Array(5), db: new Float32Array(5), dnorm: new Float32Array(5).fill(0.5),
      has: new Uint8Array(5), seen: 0, stale: false, quality: 1, qv: 0, qbuf: new Float32Array(30), qhead: 0, qcount: 0,
      hist: BANDS.map(() => ({ buf: new Float32Array(CONFIG.historyLen), head: 0, count: 0 })) };
  }
  ingest(frame) {
    if (!frame || !frame.bands) return;
    const now = performance.now();
    const dt = this.lastIngest ? Math.min(2, (now - this.lastIngest) / 1000) : 0;
    this.lastIngest = now;
    if (frame.units && frame.units !== this.units) {
      if (this.units !== null) { this.ranges.forEach(r => (r.init = false)); this._win.forEach(w => (w.length = 0)); }
      this.units = frame.units;
    }
    let added = false;
    BANDS.forEach((band, bi) => {
      const vals = frame.bands[band];
      if (!vals) return;
      const snap = [];
      for (const name of Object.keys(vals)) {
        let r = this.records.get(name);
        if (!r) { r = this._newRecord(name); this.records.set(name, r); this.list.push(r); added = true; }
        const v = vals[name];
        r.raw[bi] = v; r.has[bi] = 1; r.seen = now; snap.push(v);
        const h = r.hist[bi]; h.buf[h.head] = v; h.head = (h.head + 1) % h.buf.length; h.count = Math.min(h.count + 1, h.buf.length);
      }
      const w = this._win[bi], R = this.ranges[bi];
      const med = snap.slice().sort((a, b) => a - b)[snap.length >> 1], mid = Math.max(Math.abs(R.hi), Math.abs(R.lo), 1e-30);
      if (R.init && !this.locked && w.length > 5 && Number.isFinite(med) && Math.abs(med) > 0 && (Math.abs(med) / mid > 1e3 || Math.abs(med) / mid < 1e-3)) { w.length = 0; R.init = false; }
      w.push(snap); if (w.length > CONFIG.rangeWindow) w.shift();
      let fmax = -Infinity; for (const v of snap) if (v > fmax) fmax = v; R.fmax = fmax;
    });
    for (const r of this.list) { const st = now - r.seen > CONFIG.staleChannelMs; if (st !== r.stale) { r.stale = st; added = true; } }
    if (added) this.version++;
    this.frames++;
    const recompute = now - this._lastRangeAt >= CONFIG.rangeEveryMs || this.frames < 3;
    if (recompute) this._lastRangeAt = now;
    BANDS.forEach((band, bi) => {
      const R = this.ranges[bi], w = this._win[bi];
      if (!w.length) return;
      if (recompute && !this.locked) {
        let n = 0; for (const s of w) n += s.length;
        const all = new Float64Array(n); let i = 0;
        for (const s of w) for (const v of s) all[i++] = v;
        all.sort();
        const pct = p => { const x = p * (n - 1), a = Math.floor(x), b = Math.min(n - 1, a + 1); return all[a] + (all[b] - all[a]) * (x - a); };
        R.tlo = pct(CONFIG.rangePct[0]); R.thi = pct(CONFIG.rangePct[1]);
        if (!R.init) { R.lo = R.tlo; R.hi = R.thi; R.init = true; }
      }
      if (!this.locked && R.init && dt > 0) {
        const k = 1 - Math.exp(-dt / CONFIG.rangeTau), kk = this.frames < 50 ? Math.max(k, 0.25) : k;
        R.lo += (R.tlo - R.lo) * kk;
        if (R.fmax > R.hi) R.hi += (R.fmax - R.hi) * Math.max(kk, 1 - Math.exp(-dt / CONFIG.rangeAttackTau));
        else R.hi += (R.thi - R.hi) * kk;
      }
      const span = Math.max(R.hi - R.lo, Math.abs(R.hi) * 1e-6, 1e-30);
      let clip = NaN;
      for (const r of this.list) if (r.has[bi]) {
        r.norm[bi] = Math.min(1, Math.max(0, (r.raw[bi] - R.lo) / span));
        if (!r.stale && r.raw[bi] > R.hi + span * 0.01 && !(r.raw[bi] <= clip)) clip = r.raw[bi];
      }
      R.clip = clip;
    });
    for (const cb of this._ingestCbs) cb(this);
  }
}

// ---------------------------------------------------------------------------------------------
// Ring buffer of scalar samples
export class Ring {
  constructor(n) { this.buf = new Float32Array(n); this.head = 0; this.count = 0; }
  push(v) { this.buf[this.head] = v; this.head = (this.head + 1) % this.buf.length; this.count = Math.min(this.count + 1, this.buf.length); }
  at(i) { const L = this.buf.length; return this.buf[(this.head - this.count + i + L) % L]; }   // 0 = oldest
  last() { return this.count ? this.at(this.count - 1) : NaN; }
  stats(n = this.count) { // mean/std of the last n finite values
    let s = 0, s2 = 0, c = 0; const st = Math.max(0, this.count - n);
    for (let i = st; i < this.count; i++) { const v = this.at(i); if (Number.isFinite(v)) { s += v; s2 += v * v; c++; } }
    const mu = c ? s / c : NaN; return { mu, sd: c > 1 ? Math.sqrt(Math.max(0, s2 / c - mu * mu)) : NaN, n: c };
  }
  clear() { this.head = 0; this.count = 0; }
}

export const METRICS = {
  engagement: { label: 'Engagement', short: 'β/(α+θ)', fmt: v => v.toFixed(2), formula: 'β / (α + θ)', desc: 'Pope et al. 1995 · all channels', log: true },
  relaxation: { label: 'Relaxation', short: 'α/β', fmt: v => v.toFixed(2), formula: 'α / β', desc: 'Alpha over beta · all channels', log: true },
  faa:        { label: 'Frontal asymmetry', short: 'FAA', fmt: v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2), formula: 'ln α F4 − ln α F3', desc: '> 0 approach · < 0 withdrawal', log: false },
  tbr:        { label: 'Theta / beta', short: 'θ/β', fmt: v => v.toFixed(2), formula: 'θ / β  (Fz, Cz)', desc: 'Rises with drowsiness, mind-wandering', log: true },
};
export const METRIC_KEYS = Object.keys(METRICS);

const FREQS = (() => { const n = 72, a = Math.log(1), b = Math.log(45); return Float32Array.from({ length: n }, (_, i) => Math.exp(a + (b - a) * i / (n - 1))); })();
export const SPEC_FREQS = FREQS;

export class Analytics {
  constructor(store) {
    this.store = store;
    this.metric = Object.fromEntries(METRIC_KEYS.map(k => [k, new Ring(CONFIG.metricLen)]));
    this.global = BANDS.map(() => new Ring(CONFIG.metricLen));
    this.baseline = { state: 'none', progress: 0, t0: 0, dur: CONFIG.baselineSec, acc: new Map(), mean: new Map(), metric: {}, at: 0 };
    this.dRange = BANDS.map(() => 2);
    this.aec = { names: [], R: new Float32Array(0), band: -1, at: 0 };
    this._tmpA = new Float32Array(CONFIG.aecWindow); this._tmpB = new Float32Array(CONFIG.aecWindow);
    this._frame = 0;
    store.onIngest(() => this._onIngest());
  }
  reset() {
    for (const r of Object.values(this.metric)) r.clear();
    for (const r of this.global) r.clear();
    this.baseline = { state: 'none', progress: 0, t0: 0, dur: CONFIG.baselineSec, acc: new Map(), mean: new Map(), metric: {}, at: 0 };
  }
  live() { return this.store.list.filter(r => !r.stale); }
  _bandMean(bi, filter) {
    let s = 0, c = 0;
    for (const r of this.store.list) if (!r.stale && r.has[bi] && (!filter || filter(r))) { s += r.raw[bi]; c++; }
    return c ? s / c : NaN;
  }
  _onIngest() {
    const st = this.store, now = performance.now();
    this._frame++;
    const G = BANDS.map((_, bi) => this._bandMean(bi));
    G.forEach((g, bi) => this.global[bi].push(g));
    const [, th, al, be] = G;
    const pick = n => st.record(n);
    const F3 = pick('F3'), F4 = pick('F4');
    const mid = r => /^(fz|cz)$/i.test(r.name);
    const thM = this._bandMean(1, mid), beM = this._bandMean(3, mid);
    const m = {
      engagement: be / (al + th),
      relaxation: al / be,
      faa: F3 && F4 && !F3.stale && !F4.stale && F3.has[2] && F4.has[2] ? Math.log(F4.raw[2]) - Math.log(F3.raw[2]) : NaN,
      tbr: Number.isFinite(thM / beM) ? thM / beM : th / be,
    };
    for (const k of METRIC_KEYS) this.metric[k].push(Number.isFinite(m[k]) ? m[k] : NaN);

    // ---- signal quality: jitter of log total power (frame-to-frame), relative to the montage median ----
    const jit = [];
    for (const r of st.list) {
      if (r.stale) continue;
      let tot = 0; for (let b = 0; b < 5; b++) if (r.has[b]) tot += r.raw[b];
      const lt = Math.log(Math.max(tot, 1e-30));
      r.qbuf[r.qhead] = lt; r.qhead = (r.qhead + 1) % 30; r.qcount = Math.min(30, r.qcount + 1);
      if (r.qcount > 4) {
        // median absolute frame-to-frame change: robust to brief artefacts (blinks), high for a loose electrode
        const d = [];
        for (let i = 1; i < r.qcount; i++) d.push(Math.abs(r.qbuf[(r.qhead - i + 30) % 30] - r.qbuf[(r.qhead - i - 1 + 30) % 30]));
        d.sort((a, b) => a - b);
        r.qv = d[d.length >> 1];
        jit.push(r.qv);
      }
    }
    if (jit.length) {
      jit.sort((a, b) => a - b);
      const med = Math.max(jit[jit.length >> 1], 0.02);
      for (const r of st.list) {
        const q = r.stale ? 0 : 1 - Math.min(1, Math.max(0, (r.qv / med - 2.5) / 5));
        r.quality += (q - r.quality) * 0.25;
      }
    }

    // ---- baseline ----
    const B = this.baseline;
    if (B.state === 'recording') {
      for (const r of st.list) {
        if (r.stale) continue;
        let a = B.acc.get(r.name); if (!a) B.acc.set(r.name, (a = { s: new Float64Array(5), n: new Uint32Array(5) }));
        for (let b = 0; b < 5; b++) if (r.has[b] && r.raw[b] > 0) { a.s[b] += Math.log10(r.raw[b]); a.n[b]++; }
      }
      B.progress = Math.min(1, (now - B.t0) / (B.dur * 1000));
      if (B.progress >= 1) {
        B.mean = new Map(); for (const [k, a] of B.acc) B.mean.set(k, Float64Array.from(a.s, (s, b) => (a.n[b] ? s / a.n[b] : NaN)));
        const n = Math.round(B.dur * CONFIG.rateHz);
        for (const k of METRIC_KEYS) { const ring = this.metric[k], vals = []; for (let i = Math.max(0, ring.count - n); i < ring.count; i++) { const v = ring.at(i); if (Number.isFinite(v)) vals.push(METRICS[k].log ? Math.log(v) : v); } const mu = vals.reduce((a, b) => a + b, 0) / (vals.length || 1); const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mu) ** 2, 0) / (vals.length || 1)); B.metric[k] = { mu, sd }; }
        B.state = 'ready'; B.at = now;
      }
    }
    // ---- dB change vs baseline + symmetric adaptive range ----
    if (B.state === 'ready') {
      for (let b = 0; b < 5; b++) {
        let mx = 0;
        for (const r of st.list) {
          const mu = B.mean.get(r.name);
          if (!mu || !r.has[b] || !Number.isFinite(mu[b])) { r.db[b] = 0; continue; }
          r.db[b] = 10 * (Math.log10(Math.max(r.raw[b], 1e-30)) - mu[b]);
          if (!r.stale) mx = Math.max(mx, Math.abs(r.db[b]));
        }
        const tgt = Math.max(1.5, mx);
        this.dRange[b] += (tgt - this.dRange[b]) * (tgt > this.dRange[b] ? 0.3 : 0.02);
        const D = this.dRange[b];
        for (const r of st.list) r.dnorm[b] = Math.min(1, Math.max(0, 0.5 + r.db[b] / (2 * D)));
      }
    }
  }
  startBaseline(sec = CONFIG.baselineSec) { this.baseline = { state: 'recording', progress: 0, t0: performance.now(), dur: sec, acc: new Map(), mean: new Map(), metric: {}, at: 0 }; }
  clearBaseline() { this.baseline = { state: 'none', progress: 0, t0: 0, dur: CONFIG.baselineSec, acc: new Map(), mean: new Map(), metric: {}, at: 0 }; }

  // z-score of a metric vs baseline (if calibrated) or the rolling 60 s reference
  metricZ(key, smoothN = 10) {
    const ring = this.metric[key], L = METRICS[key].log, tr = v => (L ? Math.log(v) : v);
    const cur = ring.stats(smoothN).mu;
    if (!Number.isFinite(cur)) return { z: 0, ref: 'none' };
    let mu, sd, ref;
    if (this.baseline.state === 'ready' && this.baseline.metric[key]) { ({ mu, sd } = this.baseline.metric[key]); ref = 'baseline'; }
    else {
      let s = 0, s2 = 0, c = 0;
      for (let i = 0; i < ring.count; i++) { const v = ring.at(i); if (Number.isFinite(v)) { const x = tr(v); s += x; s2 += x * x; c++; } }
      if (c < 20) return { z: 0, ref: 'warming' };
      mu = s / c; sd = Math.sqrt(Math.max(0, s2 / c - mu * mu)); ref = 'rolling';
    }
    let curT = 0, n = 0; for (let i = Math.max(0, ring.count - smoothN); i < ring.count; i++) { const v = ring.at(i); if (Number.isFinite(v)) { curT += tr(v); n++; } }
    curT /= n || 1;
    return { z: (curT - mu) / Math.max(sd, 0.04), ref };
  }

  // Amplitude-envelope correlation (Pearson of log band power) over the last aecWindow frames
  computeAEC(bi) {
    const list = this.live().filter(r => r.m && r.has[bi]);
    const N = list.length, W = CONFIG.aecWindow, R = new Float32Array(N * N);
    const series = list.map(r => { const a = new Float32Array(W); const c = this.store.tail(r, bi, W, a); for (let i = 0; i < c; i++) a[i] = Math.log(Math.max(a[i], 1e-30)); return { a, c }; });
    const n = Math.min(...series.map(s => s.c), W);
    if (n < 15) { this.aec = { names: list.map(r => r.name), R, band: bi, n }; return this.aec; }
    const z = series.map(({ a }) => { let mu = 0; for (let i = 0; i < n; i++) mu += a[i]; mu /= n; let sd = 0; for (let i = 0; i < n; i++) sd += (a[i] - mu) ** 2; sd = Math.sqrt(sd / n) || 1; const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = (a[i] - mu) / sd; return o; });
    for (let i = 0; i < N; i++) { R[i * N + i] = 1; for (let j = i + 1; j < N; j++) { let s = 0; const A = z[i], Bz = z[j]; for (let k = 0; k < n; k++) s += A[k] * Bz[k]; R[i * N + j] = R[j * N + i] = s / n; } }
    this.aec = { names: list.map(r => r.name), R, band: bi, n };
    return this.aec;
  }
}

// Inter-brain synchrony: mean Pearson r of log band power of homologous channels over the last W frames.
export function interBrainSync(storeA, storeB, bi, W = CONFIG.aecWindow) {
  const a = new Float32Array(W), b = new Float32Array(W), pairs = [];
  for (const ra of storeA.list) {
    if (ra.stale || !ra.m || !ra.has[bi]) continue;
    const rb = storeB.record(ra.name); if (!rb || rb.stale || !rb.has[bi]) continue;
    const ca = storeA.tail(ra, bi, W, a), cb = storeB.tail(rb, bi, W, b), n = Math.min(ca, cb);
    if (n < 15) continue;
    let ma = 0, mb = 0; for (let i = 0; i < n; i++) { a[ca - n + i] = Math.log(Math.max(a[ca - n + i], 1e-30)); b[cb - n + i] = Math.log(Math.max(b[cb - n + i], 1e-30)); ma += a[ca - n + i]; mb += b[cb - n + i]; }
    ma /= n; mb /= n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { const x = a[ca - n + i] - ma, y = b[cb - n + i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
    pairs.push({ name: ra.name, r: sab / Math.sqrt(saa * sbb || 1) });
  }
  const mean = pairs.length ? pairs.reduce((s, p) => s + p.r, 0) / pairs.length : NaN;
  return { mean, pairs };
}

// Spectrum estimate from band powers: per-band densities anchored at geometric band centres,
// monotone cubic (Fritsch-Carlson) in log-f / log-P, linear extrapolation at the ends.
export function spectrumFromBands(raw, has, out = new Float32Array(FREQS.length)) {
  const xs = [], ys = [];
  BANDS.forEach((b, i) => { if (!has[i] || !(raw[i] > 0)) return; const { lo, hi } = BAND_INFO[b]; xs.push(Math.log(Math.sqrt(lo * hi))); ys.push(Math.log10(raw[i] / (hi - lo))); });
  const n = xs.length;
  if (n < 2) { out.fill(NaN); return out; }
  const d = [], mS = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  mS.push(d[0]); for (let i = 1; i < n - 1; i++) mS.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2); mS.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) { if (d[i] === 0) { mS[i] = mS[i + 1] = 0; continue; } const a = mS[i] / d[i], b = mS[i + 1] / d[i], s = a * a + b * b; if (s > 9) { const t = 3 / Math.sqrt(s); mS[i] = t * a * d[i]; mS[i + 1] = t * b * d[i]; } }
  for (let k = 0; k < FREQS.length; k++) {
    const x = Math.log(FREQS[k]);
    if (x <= xs[0]) { out[k] = ys[0] + (x - xs[0]) * Math.min(d[0], -0.6); continue; }
    if (x >= xs[n - 1]) { out[k] = ys[n - 1] + (x - xs[n - 1]) * Math.min(d[n - 2], -0.8); continue; }
    let i = 0; while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    out[k] = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * mS[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * mS[i + 1];
  }
  return out;
}
