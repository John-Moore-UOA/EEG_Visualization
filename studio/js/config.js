// ===== CONFIG =====
// Pure data + colour maths. No THREE, no DOM.

export const PARAMS = new URLSearchParams(location.search);
export const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const D2R = Math.PI / 180;

export const BANDS = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
export const BAND_INFO = {
  delta: { label: 'Delta', glyph: 'δ', lo: 1,  hi: 4,  hz: '1–4 Hz',   desc: 'Deep sleep; frontal blink artefact' },
  theta: { label: 'Theta', glyph: 'θ', lo: 4,  hi: 8,  hz: '4–8 Hz',   desc: 'Drowsiness, working memory' },
  alpha: { label: 'Alpha', glyph: 'α', lo: 8,  hi: 13, hz: '8–13 Hz',  desc: 'Relaxed wakefulness; posterior, eyes closed ↑' },
  beta:  { label: 'Beta',  glyph: 'β', lo: 13, hi: 30, hz: '13–30 Hz', desc: 'Active thinking, motor planning' },
  gamma: { label: 'Gamma', glyph: 'γ', lo: 30, hi: 45, hz: '30–45 Hz', desc: 'High frequency; often muscle (EMG) artefact' },
};

export const CONFIG = {
  defaultBand: BANDS.includes(PARAMS.get('band')) ? PARAMS.get('band') : 'alpha',
  wsDefaultUrl: 'ws://localhost:8765',
  rateHz: 10,
  staleMs: 1000,
  staleChannelMs: 2000,
  staleReconnectMs: 10000,
  backoffSec: [1, 2, 4, 8, 10],
  historyLen: 600,           // 60 s at 10 Hz per channel per band
  rangeWindow: 200,          // 20 s of frames for the adaptive range
  rangePct: [0.02, 0.98],
  rangeEveryMs: 500,
  rangeTau: 4,
  rangeAttackTau: 0.6,
  smoothTau: 0.12,
  bandMixMs: REDUCED_MOTION ? 150 : 600,
  aecWindow: 60,             // 6 s envelope-correlation window
  metricLen: 600,            // 60 s metric history
  baselineSec: 20,
  splineLambda: 1e-7,
  dprCap: 2,
  avatarUrl: PARAMS.get('avatar') || '../avatars/Ch36_nonPBR.fbx',
};

// 10-20 montage. BESA spherical convention: th = signed inclination from Cz (neg = left), ph = azimuth.
// World (head frame): +Y superior, +Z anterior (nose), +X = subject's LEFT (Mixamo characters face +Z, LeftArm at +X).
export const MONTAGE = [
  { name: 'Fp1', th: -92, ph: -72, region: 'Left prefrontal',          side: 'L', d10: true },
  { name: 'Fp2', th:  92, ph:  72, region: 'Right prefrontal',         side: 'R', d10: true },
  { name: 'F7',  th: -92, ph: -36, region: 'Left inferior frontal',    side: 'L' },
  { name: 'F8',  th:  92, ph:  36, region: 'Right inferior frontal',   side: 'R' },
  { name: 'F3',  th: -60, ph: -51, region: 'Left frontal',             side: 'L', d10: true },
  { name: 'F4',  th:  60, ph:  51, region: 'Right frontal',            side: 'R', d10: true },
  { name: 'Fz',  th:  46, ph:  90, region: 'Midline frontal',          side: 'M' },
  { name: 'T7',  th: -92, ph:   0, region: 'Left temporal',            side: 'L' },
  { name: 'T8',  th:  92, ph:   0, region: 'Right temporal',           side: 'R' },
  { name: 'C3',  th: -46, ph:   0, region: 'Left central',             side: 'L', d10: true },
  { name: 'C4',  th:  46, ph:   0, region: 'Right central',            side: 'R', d10: true },
  { name: 'Cz',  th:   0, ph:   0, region: 'Vertex',                   side: 'M' },
  { name: 'P7',  th: -92, ph:  36, region: 'Left posterior temporal',  side: 'L' },
  { name: 'P8',  th:  92, ph: -36, region: 'Right posterior temporal', side: 'R' },
  { name: 'P3',  th: -60, ph:  51, region: 'Left parietal',            side: 'L', d10: true },
  { name: 'P4',  th:  60, ph: -51, region: 'Right parietal',           side: 'R', d10: true },
  { name: 'Pz',  th:  46, ph: -90, region: 'Midline parietal',         side: 'M' },
  { name: 'O1',  th: -92, ph:  72, region: 'Left occipital',           side: 'L', d10: true },
  { name: 'O2',  th:  92, ph: -72, region: 'Right occipital',          side: 'R', d10: true },
];
for (const m of MONTAGE) {
  const th = m.th * D2R, ph = m.ph * D2R;
  m.dir = [-Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
}
const BY_NAME = new Map(MONTAGE.map(m => [m.name.toLowerCase(), m]));
export const montageFor = name => BY_NAME.get(String(name).trim().toLowerCase()) || null;
export const montageChannels = n => MONTAGE.filter(m => n === 19 || m.d10).map(m => m.name);

// ---- themes: one sequential map (absolute), one diverging map (vs baseline), UI accent ----
// Sequential maps are monotone in lightness; 'aurora' is viridis (CVD-safe).
export const THEMES = {
  dusk: {
    label: 'Dusk', sub: 'Plum to bone', ui: 'dark', finish: 'graphite', accent: '#ffc58a',
    seq: ['#603d6b', '#8f4471', '#bb5069', '#dc665a', '#f28651', '#fcab60', '#ffd08c', '#fef1d0'],
    div: ['#9cc7ff', '#6d9be0', '#4a6ea8', '#34465f', '#2b2f36', '#5e4436', '#9a6040', '#d4834a', '#ffb26b'],
  },
  ember: {
    label: 'Ember', sub: 'Single warm hue', ui: 'dark', finish: 'graphite', accent: '#ffd29a',
    seq: ['#663b26', '#90502b', '#b9692d', '#da893a', '#eeab5b', '#fad094', '#fdecd1'],
    div: ['#a8d4ff', '#74a6dc', '#4f78a6', '#37495e', '#2c2e33', '#5f4430', '#9c6533', '#d38f45', '#fbc77a'],
  },
  aurora: {
    label: 'Aurora', sub: 'Colour-blind safe', ui: 'dark', finish: 'graphite', accent: '#9ff0c6',
    seq: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
    div: ['#4fb3ff', '#3b8fd0', '#2f6c9c', '#2a4a64', '#262c33', '#4f4a2a', '#8c7b26', '#c8ad2a', '#fde725'],
  },
  clinical: {
    label: 'Clinical', sub: 'Light interface', ui: 'light', finish: 'porcelain', accent: '#2f6bd8',
    seq: ['#efd29a', '#e9b072', '#e08b58', '#cd6650', '#ad4457', '#7f2f60', '#4e2459'],
    div: ['#1f5fbf', '#4a83d1', '#86ade0', '#c3d4ea', '#e9e6e1', '#efc9a7', '#e39a68', '#cc6a3c', '#a2401f'],
  },
};
export const THEME_KEYS = Object.keys(THEMES);

const hexToRgb = h => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

// A colour map object: sample(t) -> [r,g,b] in sRGB 0..1, css(t), gradient()
export function makeMap(stops) {
  const rgb = stops.map(hexToRgb);
  const sample = (t, out = [0, 0, 0]) => {
    t = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
    const s = t * (rgb.length - 1), i = Math.min(rgb.length - 2, Math.floor(s)), f = s - i, a = rgb[i], b = rgb[i + 1];
    out[0] = a[0] + (b[0] - a[0]) * f; out[1] = a[1] + (b[1] - a[1]) * f; out[2] = a[2] + (b[2] - a[2]) * f;
    return out;
  };
  return {
    stops, sample,
    css: t => { const c = sample(t); return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`; },
    gradient: (dir = '90deg') => `linear-gradient(${dir}, ` + stops.map((h, i) => `${h} ${(i / (stops.length - 1) * 100).toFixed(1)}%`).join(', ') + ')',
  };
}

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const sstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
export const mix = (a, b, t) => a + (b - a) * t;
export const easeIO = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = t => 1 - Math.pow(1 - t, 3);
