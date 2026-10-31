// ===== 2D CHARTS (canvas) =====
import { BANDS, BAND_INFO } from './config.js';
import { SPEC_FREQS } from './store.js';

export const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// HiDPI canvas: keeps the CSS size, scales the backing store; returns a ctx in CSS pixels
export function hidpi(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
  if (canvas._w !== w || canvas._h !== h || canvas._dpr !== dpr) {
    canvas._w = w; canvas._h = h; canvas._dpr = dpr;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}
const withAlpha = (c, a) => {
  if (c.startsWith('#')) { const n = c.length === 4 ? c.slice(1).split('').map(x => x + x).join('') : c.slice(1); return `rgba(${parseInt(n.slice(0, 2), 16)},${parseInt(n.slice(2, 4), 16)},${parseInt(n.slice(4, 6), 16)},${a})`; }
  return c.replace(/rgb\(([^)]+)\)/, `rgba($1,${a})`);
};

// values: array-like (oldest -> newest), NaN gaps allowed
export function sparkline(canvas, values, { color, min, max, ref = null, fill = true, pad = 2 } = {}) {
  const { ctx, w, h } = hidpi(canvas);
  ctx.clearRect(0, 0, w, h);
  const n = values.length; if (n < 2) return;
  let lo = min, hi = max;
  if (lo === undefined || hi === undefined) { lo = Infinity; hi = -Infinity; for (const v of values) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
  if (!Number.isFinite(lo)) return;
  if (hi - lo < 1e-9) { hi += 0.5; lo -= 0.5; }
  const X = i => (i / (n - 1)) * w, Y = v => pad + (1 - (v - lo) / (hi - lo)) * (h - 2 * pad);
  if (ref !== null && ref >= lo && ref <= hi) { ctx.strokeStyle = cssVar('--line-strong'); ctx.setLineDash([2, 3]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, Y(ref)); ctx.lineTo(w, Y(ref)); ctx.stroke(); ctx.setLineDash([]); }
  ctx.beginPath(); let started = false, first = 0, last = 0;
  for (let i = 0; i < n; i++) { const v = values[i]; if (!Number.isFinite(v)) continue; if (!started) { ctx.moveTo(X(i), Y(v)); started = true; first = i; } else ctx.lineTo(X(i), Y(v)); last = i; }
  ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.lineJoin = 'round'; ctx.stroke();
  if (fill && started) {
    ctx.lineTo(X(last), h); ctx.lineTo(X(first), h); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, withAlpha(color, 0.22)); g.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = g; ctx.fill();
  }
  const lv = values[last]; if (Number.isFinite(lv)) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(X(last), Y(lv), 2, 0, 7); ctx.fill(); }
}

// Spectrum: x = log f (1..45), y = log10 density; bands shaded, the selected band highlighted in its live colour
export function drawSpectrum(canvas, spec, { band, bandColor, ghost = null, yRange = null }) {
  const { ctx, w, h } = hidpi(canvas);
  ctx.clearRect(0, 0, w, h);
  const F = SPEC_FREQS, n = F.length, lf0 = Math.log(1), lf1 = Math.log(45);
  const padB = 16, padT = 6;
  const X = f => (Math.log(f) - lf0) / (lf1 - lf0) * w;
  let lo = Infinity, hi = -Infinity;
  for (const v of spec) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (yRange) { lo = Math.min(lo, yRange[0]); hi = Math.max(hi, yRange[1]); }
  if (!Number.isFinite(lo)) return;
  lo -= 0.25; hi += 0.15;
  const Y = v => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  const t1 = cssVar('--text-1'), t3 = cssVar('--text-3'), line = cssVar('--line');
  // band columns
  ctx.font = '500 10px "IBM Plex Sans", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  BANDS.forEach((b, i) => {
    const { lo: a, hi: c, glyph } = BAND_INFO[b], x0 = X(a), x1 = X(c);
    if (b === band) { const g = ctx.createLinearGradient(0, padT, 0, h - padB); g.addColorStop(0, withAlpha(bandColor, 0.0)); g.addColorStop(1, withAlpha(bandColor, 0.16)); ctx.fillStyle = g; ctx.fillRect(x0, padT, x1 - x0, h - padT - padB); }
    else if (i % 2) { ctx.fillStyle = withAlpha(t3, 0.05); ctx.fillRect(x0, padT, x1 - x0, h - padT - padB); }
    ctx.fillStyle = b === band ? t1 : t3; ctx.fillText(glyph, (x0 + x1) / 2, h - 3);
  });
  ctx.strokeStyle = line; ctx.lineWidth = 1;
  for (const f of [4, 8, 13, 30]) { ctx.beginPath(); ctx.moveTo(X(f) + 0.5, padT); ctx.lineTo(X(f) + 0.5, h - padB); ctx.stroke(); }
  ctx.beginPath(); ctx.moveTo(0, h - padB + 0.5); ctx.lineTo(w, h - padB + 0.5); ctx.stroke();
  // ghost (baseline) curve
  if (ghost) {
    ctx.beginPath(); let s = false;
    for (let k = 0; k < n; k++) { const v = ghost[k]; if (!Number.isFinite(v)) continue; const x = X(F[k]), y = Y(v); s ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), s = true); }
    ctx.setLineDash([3, 3]); ctx.strokeStyle = t3; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
  }
  // area + curve
  ctx.beginPath(); let started = false;
  for (let k = 0; k < n; k++) { const v = spec[k]; if (!Number.isFinite(v)) continue; const x = X(F[k]), y = Y(v); started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true); }
  const path = new Path2D(); // reuse for fill clip
  ctx.strokeStyle = t1; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.lineTo(w, h - padB); ctx.lineTo(0, h - padB); ctx.closePath();
  const g = ctx.createLinearGradient(0, padT, 0, h - padB); g.addColorStop(0, withAlpha(t1, 0.10)); g.addColorStop(1, withAlpha(t1, 0));
  ctx.fillStyle = g; ctx.fill();
  // selected band area in its colour
  const { lo: a, hi: c } = BAND_INFO[band];
  ctx.save(); ctx.beginPath(); ctx.rect(X(a), 0, X(c) - X(a), h - padB); ctx.clip();
  ctx.beginPath(); started = false;
  for (let k = 0; k < n; k++) { const v = spec[k]; if (!Number.isFinite(v)) continue; const x = X(F[k]), y = Y(v); started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true); }
  ctx.lineTo(w, h - padB); ctx.lineTo(0, h - padB); ctx.closePath();
  ctx.fillStyle = withAlpha(bandColor, 0.55); ctx.fill();
  ctx.restore();
  void path;
}

// Scrolling spectrogram: one column per pushed spectrum, painted into a cols x freqs ImageData and scaled up
export class Spectrogram {
  constructor(canvas, cols = 300) {
    this.canvas = canvas; this.cols = cols; this.F = SPEC_FREQS.length; this.buf = [];
    this.lo = Infinity; this.hi = -Infinity; this.map = null;
    this.off = document.createElement('canvas'); this.off.width = cols; this.off.height = this.F;
    this.octx = this.off.getContext('2d'); this.img = this.octx.createImageData(cols, this.F);
  }
  clear() { this.buf = []; this.lo = Infinity; this.hi = -Infinity; this.img.data.fill(0); this.ema = null; }
  push(spec) {
    if (!this.ema) this.ema = Float32Array.from(spec);
    else for (let k = 0; k < spec.length; k++) this.ema[k] += (spec[k] - this.ema[k]) * 0.35;
    this.buf.push(Float32Array.from(this.ema)); if (this.buf.length > this.cols) this.buf.shift();
    let lo = Infinity, hi = -Infinity; for (const v of spec) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (Number.isFinite(lo)) {
      const first = this.lo === Infinity;
      this.lo = first ? lo : Math.min(lo, this.lo + 0.004); this.hi = first ? hi : Math.max(hi, this.hi - 0.004);
    }
    this._dirty = true;
  }
  _paint(map) {
    const { cols, F } = this, d = this.img.data, n = this.buf.length, x0 = cols - n, c = [0, 0, 0];
    d.fill(0);
    // relative to each frequency's mean over the buffer, so dynamics (alpha bursts) stand out against the 1/f slope
    const mean = new Float32Array(F), cnt = new Uint16Array(F);
    for (const col of this.buf) for (let k = 0; k < F; k++) if (Number.isFinite(col[k])) { mean[k] += col[k]; cnt[k]++; }
    for (let k = 0; k < F; k++) mean[k] /= cnt[k] || 1;
    const dev = []; for (const col of this.buf) for (let k = 0; k < F; k += 4) if (Number.isFinite(col[k])) dev.push(Math.abs(col[k] - mean[k]));
    dev.sort((a, b) => a - b);
    const R = Math.max(0.08, dev[Math.floor(dev.length * 0.97)] || 0.08);
    for (let i = 0; i < n; i++) {
      const col = this.buf[i];
      for (let k = 0; k < F; k++) {
        const v = col[k]; if (!Number.isFinite(v)) continue;
        map.sample(0.5 + (v - mean[k]) / (2 * R), c);
        const o = ((F - 1 - k) * cols + x0 + i) * 4;
        d[o] = c[0] * 255; d[o + 1] = c[1] * 255; d[o + 2] = c[2] * 255; d[o + 3] = 255;
      }
    }
    this.octx.putImageData(this.img, 0, 0);
  }
  draw(map) {
    if (this._dirty || map !== this.map) { this._paint(map); this._dirty = false; this.map = map; }
    const { ctx, w, h } = hidpi(this.canvas);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true; ctx.drawImage(this.off, 0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1;
    const lf0 = Math.log(1), lf1 = Math.log(45);
    for (const f of [4, 8, 13, 30]) { const y = h - (Math.log(f) - lf0) / (lf1 - lf0) * h; ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); ctx.stroke(); }
  }
}

// Line chart for session / synchrony traces (0..1 values) with an optional threshold line
export function traceChart(canvas, values, { color, threshold = null, capacity = null, min = 0, max = 1 } = {}) {
  const { ctx, w, h } = hidpi(canvas);
  ctx.clearRect(0, 0, w, h);
  const line = cssVar('--line'), t3 = cssVar('--text-3');
  ctx.strokeStyle = line; ctx.lineWidth = 1;
  for (const f of [0.25, 0.5, 0.75]) { ctx.beginPath(); ctx.moveTo(0, Math.round(h * f) + 0.5); ctx.lineTo(w, Math.round(h * f) + 0.5); ctx.stroke(); }
  const Y = v => 2 + (1 - (v - min) / (max - min)) * (h - 4);
  if (threshold !== null) { ctx.strokeStyle = t3; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(0, Y(threshold)); ctx.lineTo(w, Y(threshold)); ctx.stroke(); ctx.setLineDash([]); }
  const n = values.length, cap = capacity || n; if (n < 2) return;
  const X = i => (i / (cap - 1)) * w;
  ctx.beginPath(); for (let i = 0; i < n; i++) { const v = Math.min(max, Math.max(min, values[i])); i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); }
  ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.lineTo(X(n - 1), h); ctx.lineTo(0, h); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, withAlpha(color, 0.25)); g.addColorStop(1, withAlpha(color, 0)); ctx.fillStyle = g; ctx.fill();
  if (threshold !== null) { // emphasise in-zone segments
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, Y(threshold)); ctx.clip();
    ctx.beginPath(); for (let i = 0; i < n; i++) { const v = Math.min(max, Math.max(min, values[i])); i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); }
    ctx.lineWidth = 2.6; ctx.strokeStyle = color; ctx.stroke(); ctx.restore();
  }
}
