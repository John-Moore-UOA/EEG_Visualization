# DESIGN REVIEW: "Scalp" build vs DESIGN_SPEC (design agent, round 2)

Reviewed: `index.html` (1585 lines), CODER_NOTES (23 deviations), all 20 `shot_coder_*.png`, plus my own Playwright renders.

I did not edit `index.html`. To check that the head recipe below actually works, I patched a scratch copy. The evidence is:
- Screenshots: `team/shot_design_proto_{home,front,left,m19,back_burst}.png`.
- The patch: `team/design_proto.diff` (≈120 lines). It is a working reference. Port it rather than re-derive it.

---

## 0. Verdict in one paragraph

The chrome is excellent and the data layer is solid. The coder's deviations are mostly right, and several correct mistakes in my spec. Three things block "really impressive":

1. **The whole montage is mirrored.** This is a correctness bug, and it is **my spec's fault**.
2. **The head doesn't read as a head.** Flat-shaded graphite, a moiré facet net, a murky face and a lump ear.
3. **Electrodes on the horizon bloom into glare blobs.**

The fix for (2) is a deliberate abstraction, not more realism:
- a smooth-shaded dark head with a strong fresnel rim;
- below the scalp cap, the head and neck are drawn as glowing horizontal **topographic contour lines** (a "scan" of the face);
- a near-profile camera.

That one idea echoes the heatmap isolines, makes the face legible from 3/4 and profile, and turns the weakest part of the frame into the signature look. Proven in `shot_design_proto_home.png`.

---

## 1. Design critique (design-critique structure)

### First impression (2 s), coder build `shot_coder_alpha.png`
- **The orchestrator's notes: confirmed on all six points, with one sharpening.** The "orange blob at the silhouette" is **O1's HDR core**. It still blooms when it sits past the horizon, because the halo fades by facing but the core doesn't.
- **The eye lands first on that glare blob, then on the dark lower half of the head.** It should land on the heatmap gradient. The head's lower 45% is a low-contrast faceted mass that reads as "rock", not "face".
- **Purpose is clear from the chrome, not from the 3D.**

### Usability
| Finding | Severity | Recommendation |
|---|---|---|
| **Left/right mirrored in 3D.** In `shot_coder_view_front.png`, F3 and Fp1 sit on the *viewer's* left while we face the subject. The subject's left must appear on the viewer's right. Back and top views are mirrored the same way. The cause is my spec §3.1: "+Y up, +Z nose, −X = subject's left" is impossible in three.js's right-handed frame (right = forward × up = −X, so **left = +X**). The "L" marker is mirrored along with it. | 🔴 Critical | P0-1 |
| Default view hides the alpha story (posterior) *and* the face. | 🔴 | P0-3 camera |
| Horizon electrodes bloom into blobs that look like glitches (alpha O1, delta Fp1, m19 Pz). | 🟡 | P0-4 |
| During an alpha burst, values exceed the adaptive hi (51 vs legend max 28). The whole occiput clips to bone-white and the isolines vanish (`shot_design_proto_back_burst.png`). The legend gives no hint that values are clipped. | 🟡 | P1-2 |
| A 3D view can never show the whole scalp. The front and back halves are never visible together. | 🟡 | P1-1 topomap inset |

### Visual hierarchy
- **What draws the eye first:** the glare blob, wrongly. After the fixes it should be the heatmap gradient, then the hottest electrode cores.
- **Emphasis:** the head under the cap is too heavy (wire net plus facets) and the heatmap cap too soft-edged. Remove the net. Let contour lines carry the form at low luminance.
- **Whitespace:** the head fills ~60% of the height and sits low-centre. The proto camera (r 5.4) fills ~67% and clears the legend.

### Consistency
| Element | Issue | Fix |
|---|---|---|
| Channel names in Plex Mono | "O1/O2" read as "01/02" (table, labels, tooltip) | P0-5 |
| Electrode label 10px | Below the 11px used everywhere else; hard to read on DPR 1 | 11px |
| Three line languages | Facet wire, heatmap isolines and the stage grid compete | One language: contour lines (head) + isolines (data) + grid (stage) |

### Accessibility (quick WCAG 2.1 AA pass, measured in the browser)
- **Keyboard:** the tab order is logical (band → source → montage → 6 views → lock → 10 channel buttons → wraps). Focus ring is `--focus` 2px. ✅
- **Screen reader:**
  - The `#gl` region has `role="img"` and a band-aware `aria-label`. ✅
  - There is an `aria-live=polite` status. ✅
  - The channel buttons have accessible names ("O1, Left occipital"). ✅
- **Contrast:**
  - Text tokens: `--text-3 #8a9099` on `#0b0d10` ≈ 6:1 ✅. Legend ticks `#a3a7ad` ≈ 7.5:1 ✅.
  - Dusk low end vs the page surface: 2.20:1 ✅ (validator).
  - Dusk low end vs the head graphite `#1c2026`: **1.85:1 ❌** (validator: "FAIL light-end"). The cap's low values melt into the head at the fade edge. That is part of the "mushy band". Fixed by the darker head base `#15181d` plus contour lines under the edge (P0-2).
- **Data correctness (the a11y-adjacent one that matters most):** the mirrored montage misinforms *everyone*, and the channel table's LEFT/RIGHT columns contradict the 3D head. P0-1.
- **Minor:**
  - `select#band` textContent leaks every option into the focus name. Harmless, because the `<label>` wins.
  - The 10px electrode labels go to 11px.

### What works well (keep, don't touch)
- **Panels, chip, legend, sparklines, tooltip, honest stale/dead states, "Not placed" footer.** All production-grade.
- **The dead state** (`shot_coder_ws_dead.png`). A grey head with the rim catching the silhouette is the *best-reading head in the build*. That is the clue for the fix: less surface, more rim.
- **Convex-hull coverage, Perrin spline, relative range guard, crossfade-from-snapshot.** All correct calls.

---

## 2. Verdict on the 23 coder deviations

| # | Deviation | Verdict | Why / amendment |
|---|---|---|---|
| 1 | Dusk colormap replaces Ember | **ACCEPT** | See §3. My Ember had too little chroma and hue travel, so 5–21 µV² collapsed to "orange". Dusk is a magma-style single-family sequential: monotone L 0.42→0.96, hue spread 23°, ALL PASS on `#0b0d10` (I re-ran the validator). Keep `?cmap=ember`. |
| 2 | Icosahedron detail values | **ACCEPT, amend** | Correct about three r125+. Raise `headDetail` to **40** (33.6k tris) because the head goes smooth-shaded. Keep shell 36. Total ≈ 52k, under budget. Remove the detail-9 wire (#9). |
| 3 | Face geometry reworked | **ACCEPT, amend** | Soften the eye sockets to **−0.07, σ 0.14, centre (±0.33, −0.42, 0.84)**. At −0.085/σ0.13 they rendered as black voids. |
| 4 | Convex-hull coverage mask | **ACCEPT** | A good catch. My distance-only mask blanked Cz. Narrow the edge fade to `1 − smoothstep(100°, 112°, θ)`. |
| 5 | Lights ×π, key to camera side | **ACCEPT, amend** | After the mirror fix the home camera moves to +X. Key at **(1.6, 3.0, 2.8)**, fill at **(−3, 0.6, 1.5)**, rim at **(0.5, 2.0, −4)**, intensity **2.2·π**. |
| 6 | Grid alpha 0.010 | ACCEPT | Linear-blend reasoning is correct. |
| 7 | Fog tracks camera | ACCEPT | |
| 8 | Home camera r5.6 / 64° / −68° | **PARTIAL** | Near-profile is the right instinct, because a profile silhouette is the most recognisable head view. New values in P0-3. |
| 9 | Facet wire, coarse | **REJECT (cut)** | It reads as a moiré "rock". Replaced by contour lines (P0-2). |
| 10 | Rim 0.30·pow 3.5 | **SUPERSEDED** | The chalkiness was a flat-shading artefact. With smooth shading use **0.55·pow(1−N·V, 2.4)**. |
| 11 | Halos fade by facing | **ACCEPT, extend** | Also cap the *core* HDR by facing (P0-4). This is the actual glare-blob cause. |
| 12 | Label +10px lift | ACCEPT | |
| 13 | Neck front-side, higher fade | **ACCEPT, amend** | Smooth: `CylinderGeometry(0.36, 0.46, 1.2, 64, 1, true)`, same contour material. |
| 14–23 | Data/behaviour items (API callbacks, console.info, relative guard, units label, flat form, snapshot crossfade, DPR 2/1.5, 2-s rate window, degrade steps, WS-without-connect clears) | **ACCEPT all** | All are sound. #20: re-check 60 fps with the new 52k tris at DPR 2. The proto showed 60 fps here, but re-check on iGPU. |

---

## 3. Colormap decision: accept Dusk

The evidence is `shot_coder_alpha.png` vs `shot_coder_alpha_ember.png`.
- In the Ember shot, F3 (6.3) and C3 (11.9) are both "mid-orange", ΔE too small.
- In the Dusk shot, the plum→rose→ember→bone path separates them clearly.
- Validator, re-run by me:
  - `--ordinal --mode dark --surface #0b0d10` → ALL PASS, low end 2.20:1, hue spread 23°.
  - Against the old head colour `#1c2026` it fails (1.85:1). Handled by the darker head and contour underlay, not by changing the ramp.
- Keep the stops exactly as built. The spec's A7 acceptance criterion becomes "exactly the 8 Dusk stops". The legend gradient, LUT texture, cores, bars and swatch all come from the one `lut()` already. ✅

---

## 4. Prioritised change list

### P0: must ship (correctness + the "impressive" bar)

**P0-1 Fix the L/R mirror (my spec bug).**
- `m.dir = [-Math.sin(th)*Math.cos(ph), Math.cos(th), Math.sin(th)*Math.sin(ph)]` (negate x).
- Fix the comments: "+X = subject's LEFT, odd numbers at x > 0".
- Axis markers: `[['L', 1.22], ['R', -1.22]]`.
- `VIEWS`:
  - `left: {polar 80, az 90}`
  - `right: {polar 80, az -90}`
  - **`top: {polar 7, az 180}`**: nose up, subject-left on screen-left, the standard topoplot orientation.
  - `back` stays at 180.
- Verify:
  - The front view shows Fp1 and F3 on screen-**right**.
  - The back view shows O1 and P3 on screen-**left**.
  - The top view shows nose up and C3 on the left.
- Validation agent: spec §3.1 and its acceptance check now read "odd electrodes at x > 0".

**P0-2 Head becomes "contour scan" (replaces the faceted graphite plus wire).**

`headMaterial()` settings:
- `color 0x15181d`, `roughness 0.62`, **`flatShading false`**, `headDetail 40`.
- Delete the facet-wire mesh. Ears get `SphereGeometry(1, 28, 20)`.

`onBeforeCompile`, as in the diff:

```glsl
// vertex: after #include <begin_vertex>
vObj = (modelMatrix * vec4(transformed, 1.0)).xyz;
// fragment: after #include <emissivemap_fragment>
float fr = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 2.4);
totalEmissiveRadiance += uRim * fr * 0.55;                          // uRim = #8fa3b8
float cy = vObj.y / 0.05; float cw = fwidth(cy); float cf = abs(fract(cy - 0.5) - 0.5);
float cl = 1.0 - smoothstep(0.0, cw * 1.25, cf);                    // 1-px AA contour every 0.05 units
float below = smoothstep(0.45, 0.05, vObj.y) * (1.0 - smoothstep(-1.2, -1.75, vObj.y));
totalEmissiveRadiance += uRim * cl * below * (0.07 + 0.33 * fr);    // brighter toward silhouette
```

- The contours start at y 0.45, *under* the cap's fade band. The fade therefore dissolves into lines instead of a dark mush.
- They die out down the neck, so the bust has no hard cut.
- Keep the rim emissive below the bloom threshold. The max of `0.55 + 0.40` on `#8fa3b8` is about 0.6 luminance, under 0.9. ✅
- Eye sockets per #3.
- Ear: scale **(0.045, 0.165, 0.095)**, same position.
- Neck per #13.

**P0-3 Camera/framing.**
- `home: {polar 64, az 84}`: just in front of the left profile. The face silhouette (nose, lips, chin) is on screen-left and the posterior field on screen-right, with both visible.
- `homeRadius` min **5.4** (was 5.6).
- `TARGET (0, −0.22, 0.05)`.
- Result: the head is ≈67% of the viewport height, the crown clears the top by ~110px, and the chin clears the legend.
- Re-run the phone fit at 375×812.

**P0-4 Kill the horizon glare.** In `updateElectrodes`, after the intro scaling:

```js
_v.copy(camPos).sub(e.pos).normalize(); const facing = _v.dot(e.nrm); // hoist from the halo code below
kHdr = mix(Math.min(kHdr, 0.5), kHdr, sstep(0.05, 0.35, facing));
```

- The core stays coloured but never blooms unless it faces the camera.
- Keep the halo facing fade (#11).

**P0-5 Fix "O1 reads 01".**
- Channel *names* go in `var(--sans)` weight 500: the table cells, `.elabel`, the tooltip title and the "Not placed" footer.
- *Numbers* stay mono/tabular.
- `.elabel` goes to **11px/14px**.

### P1: strong value, moderate cost

**P1-1 2D topomap inset** (the one "wow" that adds meaning).
- A 132×132 canvas inside the legend panel, on its left, with the legend growing to 460px wide. On phone, hide it.
- Content: the classic nose-up disc in azimuthal-equidistant projection (the `project2D()` already exists), so the user sees the **whole** field at once. 3D can't do that.
- Compute: precompute spline weights for a 48×48 grid of in-disc points through the same `buildSpline`, then one mat-vec per frame, ≈1.8k×19. Paint with `lut()`.
- Overlays: the hull-coverage hatch outside the convex hull, electrode dots at 3px `--text-1`, a nose tick, and 0.1 isolines (marching squares optional; skip if costly).
- Hover sync: hovering a dot highlights the same channel.
- This also reinforces correct L/R (P0-1).

**P1-2 Burst headroom.**
- Asymmetric range smoothing: when the live p98 > hi, `hi` follows with **τ 0.6 s**. Release with the existing τ 4 s.
- When any value > hi, show a small "▸ max {v}" at the legend's right end (`--text-2`), so clipping is never silent.

**P1-3 Contour lines on the cap edge.**
- Draw one crisp coverage-boundary line where `vMask ≈ 0.5`: `col = mix(col, vec3(0.75), 0.25 * line)`.
- This turns the soft edge into an intentional "measured region" border.
- Hatch semantics stay in the legend.

**P1-4 Event pulse.**
- When a channel's normalised value rises > 0.25 within 300 ms (blinks on Fp1/Fp2 in delta, alpha onset on O1/O2), emit one expanding ring on the scalp from that electrode.
- Spec: a ring in the shell shader as `exp(-((angDist − r(t))/0.03)²)`, with r 0→0.5 rad over 900 ms, intensity 0.25, LUT colour, ≤ 4 concurrent.
- Disabled under reduced motion.
- It ties the "story" moments to space. Cheap: one uniform array.

### P2: polish
- Ambient: contour lines drift downward at 0.004 units/s for a faint "scanning" life. Off when reduced motion is on or the source is not live.
- Electrode cups: `cupMat` colour `0x3a4048` so the cups separate from the darker head.
- Stage grid: only the 3 inner rings. 5 rings plus the contour neck is busy.
- `select#band`: add `aria-describedby` → band description.

---

## 5. Cut
- **Facet wireframe** (all detail levels): replaced by contours.
- **Flat shading** on the head, ears and neck.
- **Coherence/connection arcs: do not build.** The stream carries band power only, no coherence or phase. Arcs would be invented data.
- **Realistic face pursuit:** no further sculpting beyond the P0-2 tweaks. The contour abstraction is the design. A more literal face lands in the uncanny valley at this poly budget.
- 3D "L/R" markers *stay* (now correct). Don't add A/P markers, because the nose does that job.

## 6. Acceptance checks for the validation agent
1. Front view: Fp1/F3 on screen-right. Back view: O1/P3 screen-left. Top view: nose up, C3 left.
2. No electrode within 0.05 facing of the horizon produces bloom (core luminance ≤ 0.5).
3. Home view at 1440×900 shows the nose/lip/chin silhouette *and* at least one of O1/P3.
4. No visible facet wire. The head is smooth-shaded. Contours are visible under the cap edge and fade out by y −1.75.
5. Channel names are set in Plex Sans. "O1" is unambiguous.
6. ≥ 55 fps at 1440×900, DPR 2 on the reference GPU. Triangles ≤ 60k.
