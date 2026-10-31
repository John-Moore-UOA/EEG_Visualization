// Measures envelope-correlation statistics of the synthetic subject (alpha + beta), per simulated state.
globalThis.location = { search: '' }; globalThis.matchMedia = () => ({ matches: false });
const { MockSource } = await import('../../studio/js/data.js');
const { BandPowerStore, Analytics } = await import('../../studio/js/store.js');
const { BANDS } = await import('../../studio/js/config.js');
for (const state of ['rest', 'focus', 'relax']) {
  const src = new MockSource({ seed: 0 }); src.setTarget(state);
  const store = new BandPowerStore(), an = new Analytics(store);
  let T = 0; src._t = () => T; src._t0 = 0; src._last = null; src._autoUntil = 1e9; src._nextBlink = 3; src._blinkAt = -10; src._nextLoose = 1e9; src._loose = null;
  for (const k of Object.keys(src.w)) src.w[k] = k === state ? 1 : 0;
  const out = { alpha: [], beta: [] };
  for (let i = 0; i < 1200; i++) {
    T += 0.1; store.ingest(src._frame());
    if (i > 100 && i % 20 === 0) for (const b of ['alpha', 'beta']) { const A = an.computeAEC(BANDS.indexOf(b)); const N = A.names.length; for (let x = 0; x < N; x++) for (let y = x + 1; y < N; y++) out[b].push({ r: A.R[x * N + y], p: A.names[x] + '-' + A.names[y] }); }
  }
  for (const b of ['alpha', 'beta']) {
    const rs = out[b].map(o => o.r).sort((a, b) => a - b), q = p => rs[Math.floor(p * (rs.length - 1))];
    const byPair = {}; for (const o of out[b]) (byPair[o.p] ||= []).push(o.r);
    const top = Object.entries(byPair).map(([p, v]) => [p, v.reduce((a, c) => a + c, 0) / v.length]).sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log(state.padEnd(6), b.padEnd(6), 'median', q(0.5).toFixed(2), 'p90', q(0.9).toFixed(2), '>0.55:', (rs.filter(r => r > 0.55).length / rs.length * 100).toFixed(0) + '%', 'top:', top.map(([p, r]) => p + ' ' + r.toFixed(2)).join(', '));
  }
}
