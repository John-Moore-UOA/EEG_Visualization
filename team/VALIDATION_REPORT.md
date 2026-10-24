# Validation report: `index.html` + `bridge.py`

Validation agent, 2026-10-24. I did not edit `index.html` or `bridge.py`. All test scripts are my own and live in `team/validation/`. They use Playwright headless Chromium with the D3D11 GPU, http.server on :8100, and bridges on separate ports. Raw outputs are in `team/validation/*.json`, `*.log` and `*.png`. Every server and process I started has been shut down; a final netstat check shows nothing listening on my ports.

| Script | What it checks |
|---|---|
| `v1_console.py` | Console and pageerror capture for 7 page scenarios plus a bridge kill and restart |
| `v2_anatomy.py` | Electrode world positions, symmetry, distance to the surface, and screen projections in all 6 view presets |
| `v3_data.py` | Data end to end: a WebSocket tap compared with the table, the store, the normaliser and the spline |
| `v3b_spline.py` | An independent numpy Perrin spline compared with the page's shell values; rendered pixels compared with the LUT |
| `v4_robust.py`, `v4b_fresh.py` | A hostile in-process WebSocket server (15 phases), resize storm, hidden/visible tab, volts-scale input, channel dropout |
| `v5_accept.py` | Performance, auto-rotate, label occlusion, UI/a11y, reduced motion, phone layout, auto-degrade, mock bursts |
| `v6_ui_flows.py` | UI source switching, invalid URLs, the `?ws=` alias, `--flat-band` with a band change |
| `ctrlc_run.py`, `ctrlc_generic.py`, `enable_ctrlc.py` | A real Ctrl+C sent to `bridge.py` on Windows |

---

## Defects, ranked by severity

### BLOCKER

**B1. The head is a mirror image. The subject's left hemisphere is drawn on the anatomical right.**
- **Root cause:** the convention in spec §3.1 is wrong. The coder implemented it faithfully, so this is a spec bug. Three.js is right-handed. With +Y up and +Z = nose, the subject's right is `forward × up = (0,0,1)×(0,1,0) = (−1,0,0)`. So **−X is the subject's RIGHT**, and putting odd electrodes (Fp1, C3, O1) at −X produces a mirrored head.
  - The camera itself is not mirrored: there is no negative scale anywhere in the scene graph (`v2` flag `mirrored=false`).
- **Evidence (`v2_anatomy.py`, label screen positions at 1440×900):**
  - **Front preset** (camera facing the face): Fp1 is at x=621 (viewer's left) and Fp2 at x=819. When a real subject faces you, their left (Fp1) appears on your **right**.
  - **Top preset:** the nose is at the screen bottom (Fp at y=738) and Fp1 is still on the screen left. With the nose toward the viewer, the subject's left should be on the screen right.
  - **"L" preset:** it shows Fp1/F3/C3/P3/O1 with the nose pointing to screen right (Fp1 x=1026, O1 x=401). A real left profile has the nose pointing **left**.
  - **`team/shot_coder_alpha.png`:** Fp1, F3, C3 and P3 are visible and the nose points right. That is the subject's right side wearing left-hemisphere labels.
- **Impact:** frontal-alpha asymmetry and every lateralised finding read backwards on the 3D head. The table (L/R columns) is correct; the head contradicts it.
- **Fix (minimal):**
  1. Negate X in the montage conversion: `m.dir = [-sinθcosφ, cosθ, sinθ sinφ]`. Odd channels then sit at +X.
  2. Swap the L/R markers: L at +1.22, R at −1.22.
  3. Swap the view presets: `left: az +90`, `right: az −90`.
  4. Use `home.az = +68` so the left hemisphere stays in view, and mirror the key and fill light X (`key` at +1.6).
  5. Update the coordinate comments.
  6. The design agent should correct §3.1 of the spec to "+X = subject's left (right-handed, Y up, Z anterior)".
- **Verify the fix:** in the front view, Fp1 should project to the right of Fp2.

### MAJOR

**M1. The spline does not interpolate exactly. The heatmap under an electrode differs from its value by up to 7% of the range on real bridge data, and up to 26% in the worst case. This fails A4.**
- **Cause:** the regularisation λ = 1e-5 (taken from the spec) is large relative to `g(1) ≈ 0.015` and the ill-conditioned m=4 system.
- **Evidence:**
  - The page's shell `aVal` matches my independent numpy spline to within 1e-7, so the implementation itself is correct (`v3b`).
  - The error comes from λ:
    - On frozen bridge `--mock` alpha, the spline at the electrode gave P3 0.042 → 0.112, C3 0.091 → 0.049 and C4 0.028 → 0.073 (max error 0.07).
    - Over 50 random fields, the worst error was 0.12 with 10 channels and 0.26 with 19.
    - With λ = 1e-7 the worst error drops to 0.002 / 0.006. With λ = 0 it is 0.0 (cond ≈ 8e5, which is fine in float64 with pivoting).
- **Fix:** `+ (i === j ? 1e-7 : 0)` (or 0) at index.html:1071.

**M2. Channels that stop arriving stay on screen with their last value forever, under a "Live" status.**
- **Repro (`v4b_fresh.py`):** stream 10 channels, then only Fp1/Fp2/O1/O2 (an electrode dropped out, or the bridge was restarted with a subset).
  - Four seconds later, F3–P4 still show 3.6 / 4.8 / … in the table.
  - They still drive the spline, the heatmap and the adaptive range.
  - Nothing marks them as stale.
- `BandPowerStore` never expires records (`has[bi]` is never cleared).
- **Fix:** timestamp each record per band at ingest. Treat a channel older than, say, 2 s as missing: grey its cell and drop it from the active montage (rebuild the spline), or at least desaturate it.

**M3. Case-variant channel names hijack electrodes.**
- **Repro (`v4_robust.py` phases `lowercase_names` → `valid`):** after a single frame containing `"o1"`, `"fp1"` and `"FP2"`, the electrodes O1, Fp1 and Fp2 stay bound to those new records. When the normal `"O1"` stream resumes, the table shows **O1 = 3.0 frozen** while the real O1 data (~30) is ignored.
- **Cause:** `syncMontage` builds a `recByLower` map over all records, and the most recent duplicate wins (index.html:1153).
- **Fix:** canonicalise names at ingest (map them to the MONTAGE name via `montageFor`, and keep the original only for display), so `"o1"` and `"O1"` are the same record.

**M4. In `--flat-band` mode, switching the band relabels the same data as a different band.**
- **Repro (`v6_ui_flows.py`):** run `bridge.py --mock --flat-band alpha`, open `?source=ws&url=ws://localhost:8766` and select Beta.
  - The table and legend now say "Beta power" while showing alpha values (O2 = 796 µV²; real beta is about 8–80). See `team/validation/v6_flat_labelled_beta.png`.
  - In `v4` it also mixed in stale beta values from channels that had stopped arriving.
- This follows spec §9.2 ("assigned to the currently selected band"), but on an instrument it is mislabelling. CODER_NOTES #18 says other bands show "No {band} data", which is not what happens: the next frame fills the newly selected band.
- **Fix:**
  1. Bind flat data to the band selected when the first flat frame arrives (or to a `?flatBand=` parameter).
  2. Keep it there, and show "Stream sends a single unlabelled band" under the other bands.
  3. Or add a `"band"` key to the bridge's flat form.

### MINOR

1. **The coder's "zero console errors in all scenarios" claim is false.**
   - **Evidence (`v1`):** with a dead port, and while the bridge is killed, Chromium logs `WebSocket connection to 'ws://localhost:9999/' failed: … ERR_CONNECTION_REFUSED` as console **error** on every retry (4 in 9 s, attributed to index.html:614).
   - These are browser-native network errors, not page errors, and JS cannot suppress them.
   - All other scenarios had **zero** errors, warnings or pageerrors: default, all 5 bands, Dusk, Ember, 19-ch, WS live, `--flat-band`, `--relative`, and after the restart.
   - **Fix:** document this in CODER_NOTES. Optionally lengthen the backoff after 5 failures to reduce noise.
2. **The ear rotation is never applied.** `ear.rotation.set(...)` sits inside the `//` comment on index.html:906. Measured ear rotation is `[0,0,0]` (`v5`). Move it onto its own line.
3. **A single NaN or Infinity drops the whole frame.**
   - Python's `json.dumps` emits `NaN` by default, and third-party bridges often do for a bad channel. `JSON.parse` then throws, so every channel blanks and the page goes Stale. Only one `console.info` is ever logged (`v4` phase `nan_literal`: 25 frames dropped, status Stale).
   - **Fix:** pre-sanitise with `text.replace(/\bNaN\b|-?Infinity\b/g, 'null')` before parsing.
4. **The adaptive range is poisoned for 20 s by outliers when the unit string doesn't change.**
   - After a burst of 1e9 values, volts-scale (1e-12) data rendered at norm ≈ 1e-9 (all bottom colour) with ticks "1.8 1.8e9 …" (`v4` `volts_4`).
   - On a fresh page, volts-scale input works (`v4b` `volts`: ticks 1.0e-12 … 1.2e-11, norms 0.02–1.0).
   - **Fix:** reset the range when the median magnitude jumps by more than 1e3×, or use a shorter window for the low/high targets.
5. **Negative values are accepted and shown as negative µV².** The asymmetry index then leaves [-1, 1] (shown −2.20 and +2.60). Clamp the asymmetry or skip pairs with non-positive values. Optionally flag negative power.
6. **Invalid URL leaves the wrong button state.** After `http://nope` or `ws://`, the chip says "Disconnected · invalid URL" but the button reads **Disconnect**, so the user must click twice to retry (`v6`). The `wsBtn` handler should treat `reason === 'invalid URL'` as not running.
7. **The chip reads "Live 0.0 Hz" on the first frame after a reconnect** (`v1` kill_restart `back`). Show "Live" without a rate until 2 or more arrivals are within the window.
8. **A half-open socket stays "Stale" forever and never reconnects.** For example, the network drops without a FIN. Close and reconnect after N seconds of Stale.
9. **With 19 channels, draw calls reach 85, over the §12 budget of 70.** With 10 channels it is 49 calls and 38k triangles; with 19 it is 47k triangles. FPS is unaffected on this GPU. Hiding the halo sprites of electrodes that face away, or instancing the cups and rings, would fix it.
10. **The top of the colormap blooms during the band-switch sweep.** The sweep multiplies colour by 1.12, which lifts the top stop's linear luminance from 0.885 to 0.99, above the bloom threshold of 0.9, so the high end of the heatmap blooms for about 700 ms. Clamp after the sweep, or cap the sweep gain at about 1.015 for t > 0.9.
11. **Adding a channel is not quite "add a MONTAGE row".** A row whose `row:` value isn't listed in `TABLE_ROWS` (index.html:427) is placed on the head but silently left out of the channel table, which is the accessible view. Derive `TABLE_ROWS` from MONTAGE, or add an "Other" fallback row.
12. **The volts unit label is wrong.** A source that sends volts is labelled µV², because a frame without `units` defaults to `'uV^2'`. This is cosmetic; the brief accepts it.
13. **Phone segmented-control labels are 42 px tall**, inside a 44 px box with a 1 px border (`v5` phone). Make the inner labels 44 px.
14. **bridge.py: a port conflict exits with code 0.** It prints the error but `main()` returns normally. Add `sys.exit(1)` in the `OSError` branch.
15. **Small per-frame allocations remain (P2 nit).** No `new THREE.*` appears in `animate`, but these still allocate every frame:
    - `store.hasBand()` uses an `Array.some` closure.
    - `declutterLabels()` on phones uses `filter`, `sort` and arrays.
    - `placeTooltip` builds strings.

---

## Item-by-item results for the brief

### 1. Console
See M-list item 1 for the full scenario list. All 7 page scenarios plus the kill and restart produced **0 pageerrors, 0 warnings and 0 page-originated errors**. The only errors are the browser-native WebSocket connection-refused messages for the dead port and the killed bridge.

The info logs are the expected ones:
- the unknown-channel `console.info` once per name;
- the single `[ws] ignored a message…`;
- the `[perf]` degrade steps.

On kill and restart, the page moved Live → Disconnected (values frozen, "No signal · Last data 2s ago · values frozen") → Live. Reconnection took 6.1 s after the restart, which is consistent with the 1/2/4/8 s backoff. It never fell back to mock.

### 2. Anatomy
- **Directions:** they match spec §5.1 exactly (Δ < 0.001).
- **Symmetry:** L/R pairs are symmetric to 2e-4.
- **Surface distance:** every electrode is 0.012 above the surface, as specified (well within 0.03).
- **Regions:** Fp is frontal (+Z), O is occipital (−Z), C3/C4 are lateral-central, and T7/T8 sit 0.165 above the ear top.
- **But:** the world handedness is mirrored (B1).

### 3. Data end to end
- Table text equals the last WebSocket message exactly for all 10 channels in alpha and beta (`v3`). `store.raw` and `store.norm` match my own recomputation of the percentile range.
- The smoothed `shown` value is within one frame of `norm`.
- Switching the band changes the data source: beta values ≠ alpha values, and C3/C4 beta are high, matching the bridge's mock prior.
- **Pixels:** colours sampled at 82–103 visible shell vertices match `lut(aVal)` alpha-blended over the skull with the documented grazing shade. Median error is 0.5/255. The maximum of 13/255 occurs only on contour lines at t = 0.1k, which is by design.
- The heatmap colour is correct for the spline value. The spline value at an electrode is wrong (M1).

### 4. Data and render separation
- The DATA LAYER and NORMALISATION sections (index.html:448–762) contain no THREE or DOM references, only `console.info`.
- The renderer reads `BandPowerStore` plus the status.
- Swapping to live really is just a URL change, verified:
  - `?source=ws&url=ws://localhost:8765` → Live;
  - `?ws=ws://localhost:8765` → Live;
  - UI path Mock → WebSocket → Connect → Live in under 0.5 s.
- The `SWAP-TO-LIVE POINT` block at index.html:650 documents this clearly.

### 6. Robustness
The page survived all of the following with no exceptions and no NaN in the display state:
- resize storm (320×568 up to 2560×1440; canvas re-sized correctly; no horizontal scroll at 320 or 375);
- hidden tab (render loop paused with 0 renders in 2 s while 20 data frames were still ingested), then visible again (resumed);
- unknown channels (TP9, AF7, Ch1 listed as "Not placed");
- strings, null, arrays, objects and booleans as values (dropped per value);
- 1e9 values and 1e-12 values;
- `{}`, `null`, `42`, non-JSON text and binary frames (ignored);
- the single-band shape `{"band","values"}` (accepted).

Weak spots: M2, M3, minor items 3–5 and minor item 8.

### 7. Performance
- 60.0 fps averaged over 10 s with rAF in the page; worst frame 24.6 ms. Default quality, DPR 1, 1440×900.
- Main pass: 49 draw calls and 38,042 triangles with 10 channels; 85 calls and 46,844 triangles with 19 (minor item 9).
- Under a forced 30 ms/frame load, auto-degrade logged bloom off → DPR 1 → "no further steps" and the readout showed "▼ 31 fps".

### 8. bridge.py
**Ctrl+C: PASS.**
- **How it was tested:** a hidden console via `CREATE_NO_WINDOW`, then `os.kill(0, CTRL_C_EVENT)`.
  - The tool harness makes child processes inherit the "ignore Ctrl+C" flag. So `enable_ctrlc.py` calls `SetConsoleCtrlHandler(NULL, FALSE)` and then runs `bridge.py` unchanged via `runpy`.
  - Control scripts behaved the same way: they received nothing without the re-enable and a KeyboardInterrupt with it.
- **Result:** the bridge printed "Shutting down...", exited with code 0 in **0.04 s** (or 0.05 s with a client connected), and freed the port.
- **Client side:** the connected client received a clean close `1001 (going away)` and the bridge logged "Client disconnected".
- **Not tested:** the real-LSL path under Ctrl+C. Its reader thread uses the same `stop_event` and `pull_chunk(timeout=0.2)`, so it should behave identically.

**Style ("explicit loops, no clever one-liners"):** there are no list, dict or set comprehensions and no lambdas. Mild violations:

| Line | What |
|---|---|
| 263 | `digits = 6 - int(math.floor(math.log10(abs(value)))) - 1`, a dense nested expression |
| 402 | `np.array(columns).T.tolist()`, a chained transform |
| 445 | an inline ternary for `units` |
| 478 | an inline ternary concatenated into a print |
| 282 / 284 | tuple-assignment one-liners (trivial) |

None of these is significant.

**Performance:** `compute_band_powers` takes 1.5 ms per tick for 10 ch at 256 Hz, 8.5 ms for 32 ch at 500 Hz, and 32 ms for 64 ch at 1 kHz. That is fine at 10 Hz.

---

## Design acceptance checks (§14)

| # | Result | Evidence |
|---|---|---|
| A1 | **FAIL** | The axes follow the spec literally (nose +Z, vertex +Y, odd electrodes at x<0, L marker at −X), but that convention is a mirror image (B1). Front view: Fp1 is on the viewer's left. |
| A2 | PASS | Directions exact (Δ<0.001), symmetric to 2e-4, 0.012 above the surface (`v2_anatomy.json`) |
| A3 | PASS (note) | 19 channels appear from MONTAGE rows only. T7/T8 are 0.165 above the ear top. Caveat: minor item 11 (`TABLE_ROWS`). |
| A4 | **FAIL** | The spline is not exact at electrodes: error up to 0.07 on real data and 0.26 worst case (M1). The cores are also deliberately HDR-brighter than the heatmap (k = 1 + 2.2v^1.6), so "core colour = heatmap colour" can only hold in hue. |
| A5 | PASS | Max mask below θ 115° = 0; eyes/nose ≤ 0.011; ears = 0 |
| A6 | PASS | With 10 ch, mask at T7 = 0 and at Cz = 0.88, and the coverage key is shown. With 19 ch, T7 = 0.90 and the key is hidden. |
| A7 | FAIL (documented deviation) | Dusk, not Ember (CODER_NOTES #1; Ember via `?cmap=ember`). A single `lut()` drives everything, and the pixels match the legend-gradient-derived LUT (median error 0.5/255). No per-band hue. |
| A8 | PASS | "{Band} power (µV²)", 5 ticks, 2 significant figures, values update as the range moves; first and last ticks align with the bar edges (0.0 px) |
| A9 | PASS (note) | NoToneMapping; heatmap `toneMapped:false`; top-stop luminance 0.885 < 0.9; cores bloom with value. Note minor item 10 (the sweep briefly exceeds the threshold). |
| D1 | PASS | No THREE or DOM in index.html:448–762 |
| D2 | PASS (with M4, minor items 3 and 8) | All 3 shapes accepted. Backoff of 1, 2, 4… s observed. Stale and Disconnected visuals present. Never falls back to mock. |
| D3 | PASS | The O1 alpha burst 20.7 → 50.4 µV² arrived about 8.5 s after load, held about 5 s and decayed. Posterior prior: O ≈ 17.5 against F ≈ 6.4 µV². |
| D4 | PASS | `k = 1−exp(−dt/τ)`, τ = 0.12 (index.html:1183) |
| U1 | PASS | Native select, `appearance:none`, bg #161a20, 36 px, has a label. Keys 1–5 select delta to gamma. |
| U2 | PASS | Minimum font 10 px (`.elabel` only). `--text-3` on `--panel-hover` = 5.15:1; worst measured 4.61:1 (`--text-3` on the #222831 checked segment). |
| U3 | PASS | Mock, Live, Stale and Disconnected observed, each with icon and label. `aria-live=polite` reads "Data source: …". The Connecting state was verified from code only. |
| U4 | PASS | FPS text updates at 2.0 Hz |
| U5 | PASS | Hovering O1 shows "O1 · Left occipital · 19.3 µV² · 76% of range · Alpha", a sparkline is drawn and the row is highlighted. Hovering the C4 row turns the ring #e8e6e1 and inverts the label. Esc unpins. |
| U6 | PASS | 120 label checks over 12 camera angles; no visible label is occluded by the head (raycast) |
| U7 | PASS | Tab order is band → source → montage → 6 view buttons → lock → 10 channel buttons, each with a 2 px focus ring |
| U8 | PASS (minor item 13) | 375×812 touch: no horizontal scroll, bottom sheet, head bbox [77, 89, 304, 309] clear of the legend (top 361), DPR 1.5. Segment labels are 42 px. |
| M1 | PASS | 3.0°/s (120 s per revolution). Stops on drag; resumes about 8 s after the drag ends with an eased ramp (0.2 → 1.7 → 2.9 → 3.0 °/s). |
| M2 | PASS | Crossfade completes at 603 ms. Re-switching mid-transition: maximum per-frame jump 0.054 (no snap). |
| M3 | PASS | With reduced motion: azimuth change 0 over 10 s, intro skipped (opacity 0.94 at 0.5 s), shimmer Δ = 0, sweep 0 |
| M4 | PASS | None of the excluded effects found in code or screenshots |
| P1 | PASS (minor item 9) | 60 fps; 38k triangles and 49 calls with 10 ch; 85 calls with 19 ch exceeds 70 |
| P2 | PASS (nit) | No `new THREE.*` in the loop; see minor item 15 |
| P3 | PASS | Forced load made all 3 steps fire and log via `console.info` |
| P4 | PASS (page) / note | Zero page errors and warnings. Browser-native WebSocket errors appear while the bridge is down (minor item 1). |

**Summary:** §14 actually lists 29 checks, not 25. Results: 26 PASS (several with notes), 3 FAIL (A1 and A4 on correctness, A7 as a documented visual deviation), and no UNTESTABLE items. The coder's claims of 60 fps, a correct data path and a clean console when the bridge is up all hold. The claims of correct 10-20 placement (mirrored) and zero errors in all scenarios do not.
