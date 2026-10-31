// ===== SONIFICATION =====
// Five drone voices (one per band, tuned to an A add9 chord) whose loudness follows each band's global power,
// a lowpass that opens with the feedback score, a synthetic reverb, and a soft reward chime.
const VOICES = [
  { band: 'delta', f: 55.0,   type: 'sine',     det: 0.15 },
  { band: 'theta', f: 82.41,  type: 'sine',     det: 0.25 },
  { band: 'alpha', f: 110.0,  type: 'triangle', det: 0.30 },
  { band: 'beta',  f: 246.94, type: 'sine',     det: 0.40 },
  { band: 'gamma', f: 659.25, type: 'sine',     det: 0.60, trem: 5.5 },
];

export class Sonifier {
  constructor() { this.ctx = null; this.on = false; this.volume = 0.5; }
  _init() {
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = ctx.createGain(); this.master.gain.value = 0;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 1400; this.lp.Q.value = 0.4;
    const rev = ctx.createConvolver(); rev.buffer = this._impulse(3.2);
    const wet = ctx.createGain(); wet.gain.value = 0.45; const dry = ctx.createGain(); dry.gain.value = 0.7;
    this.lp.connect(dry).connect(this.master); this.lp.connect(rev).connect(wet).connect(this.master);
    this.master.connect(ctx.destination);
    this.chimeBus = ctx.createGain(); this.chimeBus.gain.value = 0.22; this.chimeBus.connect(rev); this.chimeBus.connect(this.master);
    this.voices = VOICES.map(v => {
      const g = ctx.createGain(); g.gain.value = 0; g.connect(this.lp);
      const oscs = [-1, 1].map(s => { const o = ctx.createOscillator(); o.type = v.type; o.frequency.value = v.f; o.detune.value = s * v.det * 10; o.connect(g); o.start(); return o; });
      if (v.trem) { const l = ctx.createOscillator(), lg = ctx.createGain(); l.frequency.value = v.trem; lg.gain.value = 0.5; const tg = ctx.createGain(); tg.gain.value = 0.5; l.connect(lg).connect(tg.gain); g.disconnect(); g.connect(tg).connect(this.lp); l.start(); }
      return { ...v, g, oscs };
    });
  }
  _impulse(sec) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.6); }
    return b;
  }
  async toggle(on = !this.on) {
    if (on && !this.ctx) this._init();
    if (!this.ctx) return false;
    if (on) await this.ctx.resume();
    this.on = on;
    this.master.gain.setTargetAtTime(on ? this.volume : 0, this.ctx.currentTime, 0.4);
    return on;
  }
  // levels: 0..1 per band (global normalised power), score: 0..1 or null
  update(levels, score) {
    if (!this.ctx || !this.on) return;
    const t = this.ctx.currentTime;
    this.voices.forEach((v, i) => {
      const L = Math.max(0, Math.min(1, levels[i] || 0));
      const base = v.band === 'gamma' ? 0.012 : v.band === 'beta' ? 0.03 : 0.05;
      v.g.gain.setTargetAtTime(base * (0.25 + 1.6 * Math.pow(L, 1.3)), t, 0.35);
    });
    const cutoff = score == null ? 900 + 1200 * (levels[3] || 0) : 400 + 3600 * score * score;
    this.lp.frequency.setTargetAtTime(cutoff, t, 0.5);
  }
  chime(pitch = 1) {
    if (!this.ctx || !this.on) return;
    const t = this.ctx.currentTime;
    [[880, 0.5], [1318.5, 0.28], [1760, 0.12]].forEach(([f, a]) => {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = 'sine'; o.frequency.value = f * pitch;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(a, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
      o.connect(g).connect(this.chimeBus); o.start(t); o.stop(t + 2.5);
    });
  }
}
