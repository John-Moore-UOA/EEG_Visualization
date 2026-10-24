# Coder notes: deviations from DESIGN_SPEC.md (one line of justification each)

Evidence screenshots are `team/shot_coder_*.png`. The test scripts are `team/coder_selftest.py` (screenshots), `team/coder_functest.py` (behaviour), `team/clay.py` (geometry check with `?clay=1`) and `team/odd_server.py` (a hostile WebSocket feed).

## Visual
1. **Default colormap is "Dusk"** (`#603d6b → #8f4471 → #bb5069 → #dc665a → #f28651 → #fcab60 → #ffd08c → #fef1d0`), not "Ember".
   - Compare `shot_coder_alpha.png` with `shot_coder_alpha_ember.png`: with Ember, a 4.7→21 µV² field reads as one flat orange ball. With Dusk, the frontal→posterior gradient is clearly visible.
   - Dusk is still a single sequential ramp. Its OKLCH L rises monotonically from 0.42 to 0.96, and the hue stays warm (plum→ember→bone).
   - It passes the dataviz validator: `--ordinal --mode dark --surface #0b0d10`, ALL PASS, low end 2.20:1.
   - Ember is still available with `?cmap=ember`. One `lut()` still drives every surface.
2. **Icosahedron detail values changed** (head 20, shell 36, wire 9).
   - In three r125+, `detail` is linear (20·(d+1)² tris), not recursive. The spec's "detail 4/5" gave a 500-tri skull and a ~400-tri heatmap shell, so features and the heatmap were aliased away.
3. **Face geometry reworked.**
   - Brow ~θ102°, eyes and nasion ~θ110°, nose tip ~θ125°. The chin drops below the cranial sphere and the jaw stays wide.
   - The spec put the eyes 11° below Fp1 and squeezed the face into the sphere's underside, which rendered as a recessed "alien" void (verified with clay renders).
   - The cranium, electrode placement and the shared `shapeHead()` are unchanged in principle.
4. **Coverage mask = outside the electrodes' convex hull (topoplot projection), plus a relaxed nearest-distance guard (0.75–1.05 rad).**
   - The spec's nearest-electrode-only mask (0.42–0.70 rad) blanked Cz/the vertex. Cz is 46° from every 10-ch electrode, exactly as far as T7, so distance alone can't tell interpolation from extrapolation.
   - The temporal regions still fade with 10 ch. With 19 ch the cap is fully opaque.
5. **Light intensities ×π, and the key light moved to the camera side** (−1.6, 3, 2.8), fill to the opposite side.
   - The spec values are legacy units. Physically based r155+ divides Lambert by π, so the graphite rendered at about 18/255 and the face couldn't be read.
   - The home view looks from the front-left, so a key light from the right left the face in shadow.
6. **Stage-grid alpha ≈ 0.010 (spec 0.045).** Blending happens in a linear HalfFloat target, so sRGB-tuned alphas look about 5× brighter.
7. **Fog tracks camera distance** (near = d+1.4, far = d+6.4). The fixed 6..11 fogged the whole bust on phones, where the fit distance is about 12.
8. **Home camera:** r 5.6, polar 64°, azimuth −68°, target y −0.15.
   - At the spec's r 4.6 the head filled about 85% of the height.
   - The near-profile view shows both the frontal and the posterior field plus the face silhouette. At −35° the posterior alpha, the main story, sat on the far side.
9. **Facet wire** is drawn from a coarser tessellation (detail 9) of the same `shapeHead()`, lifted 0.006. At head detail 20 the wire becomes a moiré net.
10. **Rim fresnel:** 0.30 · pow(·, 3.5) instead of 0.45 · pow(·, 3). Grazing faces (neck, jaw) turned chalky.
11. **Halos fade by facing** (smoothstep 0.08–0.40 of normal·view). Halos of electrodes beyond the horizon floated off the silhouette.
12. **Labels:** an extra 10px screen-space lift. When an electrode faces the camera the normal offset projects to zero and the label covered the glowing core.
13. **Neck:** front-side only, and the alpha fade starts higher. The open DoubleSide cylinder read as two dark posts.

## Behaviour / data
14. **DataSource API follows the brief:** `start() / stop() / onFrame(cb) / onStatus(cb)` callbacks (the spec used EventTarget). `createSource()` reads `?source=ws&url=…`, and also `?ws=` and `?montage=19`.
15. **Unknown channels:** `console.info` once per name (not `warn`), because the brief requires zero warnings. They are also listed in the channel-panel footer as "Not placed".
16. **Range guard is relative** (`max(hi−lo, |hi|·1e-6, 1e-30)`), not absolute 1e-6. BRIDGE_NOTES says some sources send volts (~1e-12), and an absolute guard would flatten them.
17. **Units label follows the stream:** µV², "relative" (`--relative`), or the raw string. When units change, the adaptive range restarts.
18. **Flat form** (`--flat-band`) goes into the currently selected band. Other bands show "No {band} data in this stream" instead of stale or zero colour.
19. **Band crossfade** starts from a snapshot of the currently displayed (mixed) values, so re-switching mid-transition never snaps. The spec's form mixes the old band's live value.
20. **DPR cap:** 2 on desktop (the brief) instead of the spec's 1.75; 1.5 on phones.
21. **Live rate** in the chip is frames counted over the last 2 s. An EMA of instantaneous intervals showed "235 Hz" when messages arrived in a burst.
22. **Auto-degrade steps:** bloom off, then DPR 1, then no further step. The scalp shell is not re-tessellated at runtime, because rebuilding the spline weights would cause a hitch. Use `?degrade=0` to disable (screenshots use it).
23. **Choosing WebSocket without connecting** clears the store and shows "Disconnected · not connected". Old mock values never stay on screen under a WS label.

## Debug hooks (harmless, kept)
- `window.__eeg` exposes the store, view state, `setBand()`, `goView()` and the current source, for the validation agent.
- `?clay=1` renders the head in light grey to inspect the sculpt. `?band=beta` sets the initial band. `?cmap=ember` switches the colormap.
