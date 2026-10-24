# DESIGN SPEC — "Scalp" · EEG Band-Power Topography (Three.js, single file)

Author: Design agent · Audience: Coding agent (implements), Validation agent (verifies §14)
Target: one `index.html`, ~900–1200 lines, Three.js r160+ via importmap (CDN pinned, e.g. `three@0.160.0` on jsdelivr/unpkg, addons from `three@0.160.0/examples/jsm/`).

Keywords used below: **MUST** = acceptance-blocking, **SHOULD** = expected, **MAY** = stretch.

---

## 0. Problems in the brief, and what we do instead

| Brief says | Problem | What we do |
|---|---|---|
| WebSocket sends `{channel: value}` | Doesn't say **which band**. Switching bands would need a round-trip or show nothing. | Canonical message carries all bands per tick (§9.2). Bare `{channel: value}` is still accepted and treated as "the selected band". |
| "Glow by band power" (µV²) | Absolute power differs by ~100× between bands (delta ≫ gamma). One fixed scale shows gamma as all-black. | Data layer keeps raw µV²; the display uses a **per-band adaptive range** (§9.4). Legend ticks always show real µV² values for the current range. |
| 10 electrodes + "interpolated heatmap" | No temporal electrodes (T7/T8/F7/F8/P7/P8) → the side of the head is pure extrapolation. Painting confident colour there is misleading. | Spherical spline interpolation plus a **coverage mask**: opacity falls off with angular distance to the nearest electrode (§4.4). 19-channel montage supported, and switchable in mock mode. |
| Bloom/glow on a data viz | Bloom and tone mapping change colours, so the heatmap stops matching the legend. | Heatmap is **unlit, `toneMapped:false`, below bloom threshold**. Only electrode cores (HDR emissive > 1) bloom (§5.2). |
| IDW interpolation (suggested) | IDW makes "bullseye" plateaus around each electrode and ugly ridges. | **Perrin spherical spline** (m=4), precomputed as a weight matrix, so each frame costs one mat-vec (§4.3). IDW is a documented fallback only. |
| On WS drop, fall back to mock? (implied) | Silently showing synthetic data as if it were live is dishonest on a scientific instrument. | Never auto-switch to mock. Disconnected shows frozen, desaturated values and a "No signal" overlay (§9.3). |
| Gamma band | On scalp EEG gamma is mostly EMG (muscle). | Keep it, with a one-line caveat in the band descriptor. |
| Delta optional | Cheap to add | **Include delta.** 5 bands. |

---

## 1. Art direction

**Mood:** a calibrated scientific instrument in a dark lab, like a museum specimen on a measuring stage. Think surgical-navigation consoles, Zeiss/Leica microscope software, a Teenage Engineering-level restraint in the type. **Not** Tron, cyberpunk cyan, glitch, or HUD brackets.

**The governing rule: the data owns the colour.** Everything that isn't data (head, chrome, panels, grid) is neutral graphite and bone. The only saturated hue on screen is the data ramp (ember → amber → bone-white), plus small reserved status colours that always come with an icon and a label. That makes the heatmap read instantly and keeps it looking expensive.

**Materials:** matte graphite head, flat-shaded facets, a soft cool rim light catching the silhouette, and a faint facet wireframe like an engineering mesh. Electrodes look like small machined cups with a glowing core.

**What's in:** the head, the scalp heatmap, electrodes and labels, a faint polar "measuring stage" grid under the head, soft vignette, L/R orientation markers.
**Explicitly out:** particles, scanlines, chromatic aberration, film grain, lens flares, hex grids, typing/glitch text effects, rainbow/jet colormaps, per-band hues, pulsing-everything, connecting "neural network" lines between electrodes, background stars.

---

## 2. Design tokens (CSS `:root`, also mirrored in a JS `TOKENS` object)

### 2.1 Colour (dark-only app; contrast measured against the listed surface)

| Token | Hex | Use | Contrast |
|---|---|---|---|
| `--bg-0` | `#07080a` | page edge / vignette outer | – |
| `--bg-1` | `#0b0d10` | renderer clear colour, page bg | – |
| `--panel` | `rgba(16,19,23,0.74)` + `backdrop-filter: blur(14px) saturate(120%)` | panels | composites ≈ `#12161b` |
| `--panel-solid` | `#12161b` | fallback when no backdrop-filter | – |
| `--panel-hover` | `#1a1f26` | row hover / select hover | – |
| `--line` | `#232830` | hairlines, dividers | – |
| `--line-strong` | `#2f3640` | control borders | – |
| `--text-1` | `#e8e6e1` | primary text, values | 14.6:1 on panel |
| `--text-2` | `#a3a7ad` | secondary labels | 7.5:1 on panel |
| `--text-3` | `#8a9099` | captions, ticks, hints (**not** `#7d8590`, which fails on hover bg) | ≥5.1:1 on `#1a1f26` |
| `--focus` | `#eeab5b` | focus ring only (2px, offset 2px) | 9.2:1 |
| `--status-live` | `#5fb98a` | Live dot + icon | 7.6:1 |
| `--status-error` | `#d66a5e` | Disconnected dot + icon | 5.3:1 |
| `--status-mock` | `#8aa4c8` | Mock dot + icon | 7.1:1 |
| `--status-stale` | `#a3a7ad` | Stale (hollow dot) | 7.5:1 |

Status text itself stays `--text-1`. The colour is on the dot/icon only, so identity never depends on colour alone (dataviz rule).

**3D scene colours:**
- Head base `#1c2026`, flat shaded. Facet wire `#2a3038` at 0.28 opacity. Rim/fresnel `#8fa3b8`.
- Electrode cup `#2b2f35` (metalness 0.6, roughness 0.35). Cup ring hover `#e8e6e1`.
- Stage grid `#ffffff` at 0.045 opacity (rings), 0.03 (radials).
- Fog: `scene.fog = new THREE.Fog(0x0b0d10, 6, 11)`.

### 2.2 Data colormap: "Ember" (sequential, perceptually ordered, one hue family)

Why this one: this is a magnitude scale, so it gets **one hue, monotone lightness**, with low values dark (receding into the dark background) and high values bright. I built it in OKLCH with L stepping evenly from 0.40 to 0.95 and hue held to 46–80° (ember to amber to bone). Viridis/turbo were rejected: turbo is a rainbow, and viridis's blue/green/yellow fights the "data owns the colour" warmth and reads as gamer-neon on near-black. Amber also recalls phosphor instruments, which suits the art direction. Grey surroundings plus a warm ramp gives the strongest figure/ground.

**Validated** with the dataviz skill's validator: `validate_palette.js "<stops>" --ordinal --mode dark --surface "#0b0d10"` → ALL PASS (monotone L, adjacent ΔL ≥ 0.06, light-end 2.06:1 vs surface, hue spread 33°).

| t | Hex | OKLCH (L, C, h) |
|---|---|---|
| 0.000 | `#663b26` | 0.40, 0.070, 46 |
| 0.167 | `#90502b` | 0.50, 0.100, 49 |
| 0.333 | `#b9692d` | 0.60, 0.125, 54 |
| 0.500 | `#da893a` | 0.70, 0.135, 61 |
| 0.667 | `#eeab5b` | 0.79, 0.125, 69 |
| 0.833 | `#fad094` | 0.88, 0.090, 76 |
| 1.000 | `#fdecd1` | 0.95, 0.040, 80 |

Implementation: build a **256×1 `THREE.DataTexture`** LUT (RGBA8, `colorSpace = SRGBColorSpace`, `LinearFilter`, `ClampToEdge`) by linearly interpolating these 7 stops in sRGB. They're dense enough that sRGB lerp is fine. The **same JS function `lut(t) → {r,g,b,hex}`** feeds the legend CSS gradient, the electrode cores, the channel bars and the tooltip swatch, so every surface agrees exactly.

The legend's CSS gradient MUST use the same 7 stops, in order, at 0/16.7/33.3/50/66.7/83.3/100%.

### 2.3 Typography

Google Fonts: `IBM Plex Sans` (400, 500, 600) and `IBM Plex Mono` (400, 500). Use `display=swap`, with fallbacks `system-ui, -apple-system, Segoe UI, sans-serif` / `ui-monospace, Consolas, monospace`.

| Role | Font | Size / line-height | Weight | Extras |
|---|---|---|---|---|
| App title | Plex Sans | 15px / 20px | 600 | letter-spacing 0.01em |
| Subtitle | Plex Sans | 12px / 16px | 400 | `--text-3` |
| Section label | Plex Sans | 11px / 14px | 500 | uppercase, letter-spacing 0.08em, `--text-3` |
| Body / controls | Plex Sans | 13px / 18px | 400–500 | |
| Numbers (values, ticks, fps) | Plex Mono | 12px / 16px | 400 | `font-variant-numeric: tabular-nums` |
| Electrode labels (3D) | Plex Mono | 10px / 12px | 500 | letter-spacing 0.04em |
| Tooltip value | Plex Mono | 18px / 22px | 500 | |

No text smaller than 10px anywhere. Electrode labels are the only 10px text.

### 2.4 Spacing, radius, motion
- Spacing scale 4/8/12/16/24/32. Panel inset from viewport edge: **20px** desktop, **12px** mobile.
- Radius: panels 10px, controls 6px, chips 999px, bars 2px.
- Easing: `easeInOutCubic` for camera and band transitions, `easeOutCubic` for UI entry. CSS: `cubic-bezier(.65,0,.35,1)` / `cubic-bezier(.33,1,.68,1)`.
- Durations: hover 120ms, label fade 150ms, band crossfade 600ms, camera preset 900ms, intro 1400ms.
- `prefers-reduced-motion: reduce` → no auto-rotate, no sweep, no intro, crossfades 150ms, camera presets jump with a 200ms fade.

---

## 3. Head construction (procedural, no models)

### 3.1 Coordinate convention (MUST, and say so in a code comment block)
- **+Y = superior (vertex/Cz)**, **+Z = anterior (nose)**, **−X = subject's LEFT**, +X = subject's right.
- Origin = head centre, roughly the centre of the cranial sphere. Unit = cranial radius (1.0).
- Electrode odd numbers (Fp1, C3, O1…) MUST land at x < 0.
- 3D markers: CSS2D "L" at (−1.22, −0.05, 0) and "R" at (+1.22, −0.05, 0), 11px Plex Mono, `--text-3`. Plus the "A"/"P" equivalent being self-evident from the nose.

### 3.2 Deformation function `shapeHead(dir: Vector3) → Vector3`
Start from `new THREE.IcosahedronGeometry(1, 4)` (2,562 verts, 5,120 tris), then **merge vertices** (`BufferGeometryUtils.mergeVertices`). For each vertex take `d = normalize(p)` and compute the displaced position. Afterwards call `toNonIndexed()` + `computeVertexNormals()` for faceted flat shading (or `flatShading:true`).

The same `shapeHead()` MUST be reused for the scalp shell (§4) and electrode placement (§5), so all three conform.

Applied in order (all smooth functions, `sstep = smoothstep`):
1. **Cranial ellipsoid:** scale `(x*0.86, y*0.98, z*1.06)`. Real head ≈ 15.5 cm wide × 19.5 cm long.
2. **Occipital bulge:** for `d.z < 0`: `z *= 1 + 0.06 * sstep(0.0, -0.8, d.z) * sstep(-0.6, 0.2, d.y)`.
3. **Face plane & jaw** (lower front): let `low = sstep(0.05, -0.75, d.y)`.
   - Narrow: `x *= 1 - 0.28*low`.
   - Flatten the front of face: `if d.z > 0: z = mix(z, 0.86 + 0.10*d.z, 0.55*low*sstep(0.2, 0.9, d.z))`.
   - Chin: Gaussian bump centred at dir `(0, -0.78, 0.62)`, σ = 0.22 rad, amplitude +0.06 along the radial direction.
   - Under-jaw cut-in: `if d.y < -0.55: y = mix(y, -0.62, 0.5*sstep(-0.55,-0.9,d.y))`. The neck covers the rest.
4. **Brow ridge:** Gaussian band at elevation angle −8° (`d.y ≈ -0.14`), only where `d.z > 0.55`, amplitude +0.025.
5. **Eye sockets:** two Gaussian dents centred at dirs `(±0.33, -0.22, 0.92)` normalized, σ = 0.11 rad, amplitude −0.045.
6. **Nose:** anisotropic Gaussian ridge centred at dir `(0, -0.30, 0.955)` normalized. σx = 0.075 rad, σy = 0.19 rad (vertically elongated), amplitude **+0.17**. The tip sits about 0.06 below centre (offset the Gaussian centre down a bit so the bridge flows from the brow). At detail 4 that's ~6–8 facets across, a deliberately "low-poly sculpt" nose.
7. **Cheekbones:** dirs `(±0.62, -0.25, 0.72)`, σ 0.16, +0.02.

Proportion check (validation): bounding box ≈ width 1.72, height (top to chin) ≈ 1.85, length (nose tip to occiput) ≈ 2.25.

### 3.3 Ears (separate mesh, hint only)
`SphereGeometry(1, 7, 5)` scaled `(0.055, 0.17, 0.11)`, flat shaded, same material. Place at `(±0.865, -0.12, -0.04)`, rotated `y = ±0.18` rad (pinna flares back), slightly rotated `z = ∓0.08`. Ears sit **just below** T7/T8, and T7/T8 must not end up embedded in the ear (validate when the 19-ch montage is on).

### 3.4 Neck
`CylinderGeometry(0.40, 0.48, 1.1, 14, 1, true)` at `(0, -1.15, -0.12)`, tilted x = −0.12 rad. Same material, plus a vertical alpha fade to transparent at the bottom (shader `onBeforeCompile` or a gradient alphaMap), so the bust dissolves into the dark with no hard cut.

### 3.5 Head material & lighting
- `MeshStandardMaterial({ color:#1c2026, roughness:0.82, metalness:0.0, flatShading:true })`.
- **Fresnel rim** via `onBeforeCompile`: add `emissive += #8fa3b8 * pow(1.0 - saturate(dot(N, V)), 3.0) * 0.45`. Keep the result < 0.9 luminance so it never blooms.
- **Facet wireframe:** `LineSegments(new EdgesGeometry(headGeo, 1), LineBasicMaterial({color:#2a3038, transparent:true, opacity:0.28, depthWrite:false}))`, scale 1.001. Visible on face/neck. Under the heatmap it shows through at heatmap opacity (gives the "measured mesh" texture).
- Lights:
  - `HemisphereLight(#1b2230, #000000, 0.5)`
  - Key `DirectionalLight(#dfe6ee, 1.3)` at (2.5, 3.0, 2.2)
  - Fill `DirectionalLight(#8fa3b8, 0.25)` at (−3, 0.8, 1)
  - Rim `DirectionalLight(#b9c6d6, 1.4)` at (−0.5, 2.0, −4)
- No environment map, no shadows (budget). A soft fake contact shadow on the stage is allowed: radial-gradient sprite under the neck, `#000` 0.5 → 0.

### 3.6 Stage
At y = −1.75: a flat polar grid of 5 concentric rings (r = 0.6, 1.0, 1.4, 1.8, 2.2) + 12 radial lines, drawn as `LineSegments`, opacity per §2.1, fading out with radius (vertex alpha). Rotates **with** the scene: it's static, the camera orbits. No floor plane, no reflection.

---

## 4. Scalp heatmap

### 4.1 Geometry: the scalp shell
- A separate `IcosahedronGeometry(1, 6)` (~41k verts, ~82k tris). If that busts the budget, use detail 5 (~10k verts, 20k tris); detail 5 is the default and 6 is a "high quality" option. Pass each vertex direction through `shapeHead()` and push out along the radial direction by **+0.008**.
- Keep only triangles whose 3 vertices all have **polar angle θ ≤ 120°** from +Y (i.e. `d.y ≥ cos 120° = -0.5`). Do the cull at build time to save fill.
- Store per-vertex attributes: `aDir` (unit sphere direction, *pre*-deformation, used for interpolation) and `aVal` (float, updated per frame).
- Smooth shading for the shell (indexed). The shell is a smooth "skin" laid over the faceted skull, a nice contrast.

### 4.2 Coverage region & boundary fade (MUST)
Covered region: the scalp above roughly the nasion–inion line. In our idealized model the electrode equator (Fpz–T7–Oz–T8) is at θ = 90°, and nasion/inion sit at θ ≈ 112°.
- `edgeAlpha = 1 - smoothstep(100°, 115°, θ)` with θ = `acos(aDir.y)`. In the front, also fade above the eyebrows: multiply by `1 - smoothstep(0.80, 0.92, d.z) * smoothstep(-0.02, -0.16, d.y)`, so the heatmap never paints the forehead below Fp1/Fp2's brow line or the eyes.
- **Coverage mask:** let `δmin` = angular distance (rad) from the vertex to the nearest *present* electrode. `coverAlpha = 1 - smoothstep(0.42, 0.70, δmin)`. With 10 channels this visibly lightens the temporal region (honest). With 19 channels the whole cap is covered.
- `alpha = 0.92 * edgeAlpha * coverAlpha`. Computed on CPU once per montage change into an `aMask` attribute.

### 4.3 Interpolation: Perrin spherical spline (MUST), precomputed
On the unit sphere, using electrode unit vectors `e_j` (j = 1..N, the present channels only):
- `g(x) = (1/4π) Σ_{n=1}^{40} (2n+1) / (n^m (n+1)^m) · P_n(x)`, m = 4, with Legendre polynomials by recurrence `P_0=1, P_1=x, P_n = ((2n−1)x P_{n−1} − (n−1) P_{n−2}) / n`.
- Build `A` ((N+1)×(N+1)): `A[i][j] = g(e_i·e_j) + λ·δij` (λ = 1e-5 regularisation), `A[i][N] = A[N][i] = 1`, `A[N][N] = 0`. Invert once (Gauss-Jordan, N ≤ 19).
- For each shell vertex v: `G_vj = g(aDir_v · e_j)`. Then the **weight row** `W_vk = Σ_j G_vj · Ainv[j][k] + Ainv[N][k]` for k = 0..N−1. Store `W` as a `Float32Array(nVerts * N)`. Rebuild only when the montage changes.
- Per frame: `aVal_v = Σ_k W_vk · display_k`, where `display_k` ∈ [0,1] is each channel's smoothed normalised value (§7.1). For 10k verts × 10 ch that's 100k MACs, under 0.5 ms. Mark `aVal.needsUpdate = true`.
- The spline interpolates exactly at electrodes, so electrode core colour = heatmap colour under it. That's a validation check.
- Fallback (SHOULD NOT be default): angular IDW `w = 1/(δ^2 + 1e-4)`.

### 4.4 Heatmap shader (ShaderMaterial)
- `transparent:true, depthWrite:false, toneMapped:false`, `polygonOffset` (factor −1, units −1) to avoid z-fighting with the skull.
- Fragment: `t = clamp(vVal, 0, 1)`; `col = texture(uLUT, vec2(t, 0.5)).rgb`.
- **Readability shading:** `col *= mix(1.0, 0.80, pow(1.0 - NdotV, 2.0))`. This only darkens grazing angles, so camera-facing areas stay within 5% of the LUT colour.
- **Contour lines (SHOULD):** subtle isolines every 0.1 of t: `float f = fract(t*10.0); float w = fwidth(t*10.0); float line = 1.0 - smoothstep(0.0, w*1.2, min(f, 1.0-f));` then `col = mix(col, col*0.72, line*0.55)`. They give the scientific-topomap look and help read gradients without relying on colour alone (CVD).
- **Band-switch sweep** uniform `uSweep` (§8).
- **Signal-health** uniform `uSat` (1 = live; 0.35 when disconnected/stale): `col = mix(vec3(dot(col, vec3(0.2126,0.7152,0.0722))), col, uSat)`.
- Output `gl_FragColor = vec4(col, alpha)`. Keep max output luminance < bloom threshold: the top stop `#fdecd1` has linear luminance ≈ 0.85, so threshold 0.9 (§5.2) leaves it un-bloomed.

---

## 5. Electrodes

### 5.1 Placement: 10-20 on the idealized sphere (MUST)
Spherical coordinates in the **BESA convention** (θ = signed inclination from Cz in degrees, negative = left; φ = azimuth in degrees), converted with `x = sinθ·cosφ`, `y_front = sinθ·sinφ`, `z_up = cosθ`, then mapped to our axes as **`(X, Y, Z) = (x, z_up, y_front)`**. Unit vectors are precomputed below. The coding agent MUST either embed the θ/φ table and convert, or embed the vectors directly.

| Ch | θ | φ | unit dir (X, Y, Z) | Default 10-ch? | Region label |
|---|---|---|---|---|---|
| Fp1 | −92 | −72 | (−0.309, −0.035, 0.950) | ✔ | Left prefrontal |
| Fp2 | 92 | 72 | (0.309, −0.035, 0.950) | ✔ | Right prefrontal |
| F7 | −92 | −36 | (−0.809, −0.035, 0.587) | | Left inferior frontal |
| F3 | −60 | −51 | (−0.545, 0.500, 0.673) | ✔ | Left frontal |
| Fz | 46 | 90 | (0.000, 0.695, 0.719) | | Midline frontal |
| F4 | 60 | 51 | (0.545, 0.500, 0.673) | ✔ | Right frontal |
| F8 | 92 | 36 | (0.809, −0.035, 0.587) | | Right inferior frontal |
| T7 | −92 | 0 | (−0.999, −0.035, 0.000) | | Left temporal |
| C3 | −46 | 0 | (−0.719, 0.695, 0.000) | ✔ | Left central |
| Cz | 0 | 0 | (0.000, 1.000, 0.000) | | Vertex |
| C4 | 46 | 0 | (0.719, 0.695, 0.000) | ✔ | Right central |
| T8 | 92 | 0 | (0.999, −0.035, 0.000) | | Right temporal |
| P7 | −92 | 36 | (−0.809, −0.035, −0.587) | | Left posterior temporal |
| P3 | −60 | 51 | (−0.545, 0.500, −0.673) | ✔ | Left parietal |
| Pz | 46 | −90 | (0.000, 0.695, −0.719) | | Midline parietal |
| P4 | 60 | −51 | (0.545, 0.500, −0.673) | ✔ | Right parietal |
| P8 | 92 | −36 | (0.809, −0.035, −0.587) | | Right posterior temporal |
| O1 | −92 | 72 | (−0.309, −0.035, −0.950) | ✔ | Left occipital |
| O2 | 92 | −72 | (0.309, −0.035, −0.950) | ✔ | Right occipital |

Sanity: Fpz/T7/Oz on the equator (θ = 90°; BESA uses 92°), Cz at the pole, Fz/Pz at 45°, 20% arc spacing. Matches the standard idealized-sphere model used by EEGLAB/BESA.

**Positioning on the deformed head:** world position = `shapeHead(dir)` (the same function as §3.2), plus normal offset 0.012. Normal = normalized cross product of a local finite difference of `shapeHead`, or simply the scalp-shell normal at the nearest vertex. The electrode cup is oriented with `quaternion.setFromUnitVectors(+Y, normal)`.

All channel definitions live in **one `MONTAGE` table** (name, θ, φ, region, hemisphere, row/col for the panel). Adding a channel = adding a row. No other code changes. MUST.

### 5.2 Geometry, glow and value mapping
Per electrode (Group oriented to the normal):
1. **Cup:** `CylinderGeometry(0.045, 0.050, 0.020, 24)`, `MeshStandardMaterial(#2b2f35, metalness .6, roughness .35)`.
2. **Ring:** `TorusGeometry(0.047, 0.0045, 8, 32)` lying on top of the cup, `MeshBasicMaterial(#5a6270)`. On hover/focus it becomes `#e8e6e1`.
3. **Core:** `SphereGeometry(0.028, 16, 12)` (top hemisphere visible), `MeshBasicMaterial({ toneMapped:false })`, colour = `lut(v)` × **HDR intensity** `k = 1.0 + 2.2·v^1.6`. Set via `color.setRGB(r*k, g*k, b*k)` in linear space. Because k > 1 for any v > ~0.05, cores exceed the bloom threshold and bloom proportionally to value.
4. **Core scale:** `0.85 + 0.35·v`.
5. **Halo:** additive `Sprite` (radial gradient canvas texture, white → transparent), tinted `lut(v)`, size `0.10 + 0.14·v`, opacity `0.10 + 0.45·v`, `depthWrite:false`. Halo is part of the glow budget. If bloom is disabled (perf degrade), the halo alone still conveys glow.
6. **Hit target:** invisible `SphereGeometry(0.085)` for raycasting (bigger than the mark).

Mapping is from the **smoothed display value v ∈ [0,1]** (§7.1). Colour carries the value; glow and size are redundant secondary encodings, kept mild so a big-glowing electrode never visually "wins" over its colour.

**Post-processing:** `EffectComposer` → `RenderPass` → `UnrealBloomPass(res/2, strength 0.65, radius 0.35, threshold 0.9)` → `OutputPass`. `renderer.toneMapping = NoToneMapping` (so the LUT is exact), `outputColorSpace = SRGBColorSpace`. Anything else unlit (heatmap, grid, labels) stays below the threshold.

### 5.3 Labels
- `CSS2DRenderer` overlay. Each label is a `<div class="elabel">` positioned at `electrodePos + normal * 0.085`.
- Style: Plex Mono 10px/12px, weight 500, `--text-1`, background `rgba(11,13,16,0.72)`, 1px border `--line-strong`, radius 4px, padding 1px 5px, `pointer-events:none`, `transform: translate(-50%, -100%)`.
- **Back-face hiding (MUST):** each frame, compute `dot(normalWorld, normalize(camPos − pos))`. If < 0.05 → `opacity 0` (150ms CSS transition); else 1. No labels showing through the head.
- Hovered/selected label: background `#e8e6e1`, text `#0b0d10`, plus the value appended (`O1 · 14.2`).

### 5.4 Hover, tooltip, linking
- Raycast on `pointermove`, throttled to rAF, against the hit spheres only. Cursor `pointer` over an electrode.
- **Tooltip card** (HTML, follows pointer at +14px/+14px, flips to stay in the viewport). Width 200px, panel style, padding 12px:
  - Row 1: channel name (Plex Mono 13/500 `--text-1`) + region (12px `--text-3`).
  - Row 2: value **18px Plex Mono** `--text-1`, e.g. `14.2 µV²`. Next to it a 10×10 swatch of `lut(v)` with a 1px `--line-strong` border.
  - Row 3: `62% of range` (12px `--text-2`) + band name.
  - Row 4: 176×36 canvas sparkline of the last 10 s (raw µV²): 1.5px stroke `--text-2`, last point a 3px dot in `--text-1`, faint min/max dotted lines `--line-strong`.
  - Updates at 10 Hz while visible.
- **Linked highlighting (MUST):** hovering an electrode highlights its row in the channel panel (bg `--panel-hover`, left 2px bar `--text-1`). Hovering or focusing a row highlights the electrode (ring white, label inverted).
- Click an electrode or row = **pin** (sticky highlight + tooltip anchored near the panel row on desktop). Click empty space or press Esc to unpin.
- Touch: tap = pin (no hover state).

---

## 6. UI layout

Full-bleed `<canvas>` (WebGL) + CSS2D layer + an HTML overlay with `pointer-events:none` on the container and `auto` on panels.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [Title block]                                     [● Mock ▾] [60 fps]   │  top bar, 20px inset
│ ┌──────────────┐                                       ┌──────────────┐ │
│ │ BAND         │                                       │ CHANNELS     │ │
│ │ [Alpha ▾]    │                                       │ L        R   │ │
│ │ 8–13 Hz ·... │            (3D head)                  │ Fp1 ▬ │ Fp2 ▬│ │
│ │──────────────│                                       │ F3  ▬ │ F4  ▬│ │
│ │ SOURCE       │                                       │ ...          │ │
│ │ (•)Mock ( )WS│                                       └──────────────┘ │
│ │ [ws://…][Go] │                                                        │
│ │──────────────│                                                        │
│ │ VIEW  ⌂ T F L R B                                                     │
│ └──────────────┘                                                        │
│ Drag to orbit · Scroll to zoom          ┌── legend ──────────┐          │
│                                          │ Alpha power (µV²)  │          │
│                                          │ ███████████████████│          │
│                                          │ 2.1  6  10  14  18 │          │
└──────────────────────────────────────────┴────────────────────┴──────────┘
```

### 6.1 Title block (top-left)
"Scalp Topography" (title) / "EEG band power · 10–20 montage · {N} ch" (subtitle).

### 6.2 Control panel (left, width 248px, top 76px)
Sections separated by 1px `--line`, 16px padding, 14px section gaps.

**Band** (MUST be a real `<select id="band">` with a visible `<label for="band">`):
- Styling: `appearance:none`, height 36px, full width, bg `#161a20`, 1px `--line-strong`, radius 6px, padding 0 32px 0 12px, Plex Sans 13/500 `--text-1`. Inline SVG chevron at right 12px, `--text-2`. Hover border `#3a424d`. Focus-visible 2px `--focus` ring, offset 2px. Options styled `background:#12161b; color:#e8e6e1` (Chromium/Firefox honour this).
- Option text: `Delta · 1–4 Hz`, `Theta · 4–8 Hz`, `Alpha · 8–13 Hz` (**default**), `Beta · 13–30 Hz`, `Gamma · 30–45 Hz`.
- Below it a descriptor line, 12px `--text-3`, one per band:
  - delta "Deep sleep; frontal blink artefact"
  - theta "Drowsiness, working memory"
  - alpha "Relaxed wakefulness; posterior, eyes closed ↑"
  - beta "Active thinking, motor"
  - gamma "High-freq; often muscle (EMG) artefact"
- Keyboard: digits **1–5** select bands (when focus is not in a text input). The shortcut hint `1–5` appears as a 10px mono kbd chip next to the label.

**Source:**
- Radio group (real `<input type=radio>`, styled as a 2-segment control, 32px tall): `Mock` | `WebSocket`.
- When WebSocket is selected: a text input (default `ws://localhost:8765`, mono 12px) + `Connect`/`Disconnect` button (32px, 1px border, radius 6px).
- Mock mode only: `Montage: 10 / 19` segmented control so the 19-ch design can be demoed.
- `?ws=ws://host:port` URL param pre-selects WebSocket and auto-connects. `?montage=19` also works.

**View:** 6 icon-buttons, 32×32, labelled with `aria-label` + `title`: Home (3/4 view), Top, Front, Left, Right, Back. Presets animate the camera on a spherical path (lerp of spherical coords, radius constant), 900ms easeInOutCubic.

**Scale** (SHOULD): checkbox "Lock scale" (freezes the adaptive range, §9.4). Caption "Auto range · 2nd–98th pct · 20 s" in `--text-3`.

### 6.3 Channel panel (right, width 272px, top 76px, max-height calc(100vh − 200px), scroll)
- This **is the table view** (dataviz a11y requirement): a semantic `<table>` with a visually hidden `<caption>` "Band power by channel, {band}". Columns: Left hemisphere | Right hemisphere. Each `<tr>` = one region row (Prefrontal, Frontal, Central, Parietal, Occipital; with 19 ch also Inferior-frontal, Temporal, Posterior-temporal, plus a midline row spanning both columns). The mirrored L/R layout makes hemispheric asymmetry (e.g. frontal alpha asymmetry) easy to scan.
- Each cell is a focusable `<button class="ch">` (min height 40px, padding 6px 8px):
  - Line 1: name (mono 12/500 `--text-1`) left, value right (mono 12 `--text-1`, 1 decimal, µV²).
  - Line 2: magnitude bar 100% wide × 4px, track `#1f242b`, fill `lut(v)`, radius 2px, width via `transform:scaleX(v)` (origin left).
  - Line 3: sparkline 100% × 18px canvas, stroke `--text-3` 1.25px, last 10 s.
- Footer: row-level "Mean" (mono `--text-2`) and "L–R asymmetry index" for the selected band: `(R−L)/(R+L)` averaged over pairs, signed, 2 decimals. Text only, no colour.

### 6.4 Legend (bottom-centre, 20px from bottom, width 320px; panel style, padding 12px 16px)
- Title: "{Band} power" + `(µV²)` in `--text-3`, 12px/500.
- Gradient bar: 288×10px, radius 2px, CSS `linear-gradient(90deg, …7 stops…)`, 1px inner border `rgba(255,255,255,0.06)`.
- **Ticks:** 5 ticks at 0, 25, 50, 75, 100% of the current range. 1px × 4px marks in `--text-3` below the bar. Labels mono 11px `--text-2` in real µV², formatted with 2 significant figures (`0.42`, `6.1`, `18`). First/last labels align to the bar edges, not centred, so they don't overflow.
- Small caption under ticks: "Normalised per band · auto range" (or "locked") 11px `--text-3`.
- **Live indicator on legend (SHOULD):** a 2px × 14px white tick (`--text-1`) riding along the bar at the hovered/pinned channel's value. Hidden when nothing is hovered.
- Also show a tiny "coverage" key: an 8px hatched square + "Low electrode coverage" (11px `--text-3`) to explain the faded temporal regions. Only when the 10-ch montage is active.

### 6.5 Status chip & FPS (top-right)
- Chip: height 28px, radius 999px, panel style, padding 0 12px, gap 8px: `[dot/icon] Label` + secondary text.
  - **Mock**: 8px solid dot `--status-mock` + "Mock" + `--text-3` "synthetic".
  - **Connecting**: 8px ring (border 2px `--text-2`) rotating 1s linear + "Connecting…".
  - **Live**: 8px dot `--status-live` with a soft 1.6s pulse (box-shadow 0→6px, opacity 0.5→0) + "Live" + `--text-3` "{rate} Hz" (measured incoming rate).
  - **Stale** (no frame > 1 s): hollow 8px ring `--status-stale` + "Stale" + "{n}s ago".
  - **Disconnected**: an "×" glyph in `--status-error` + "Disconnected" + "retry in {n}s".
- `aria-live="polite"` region announces status changes only (never values).
- **FPS:** mono 11px `--text-3` "60 fps", updated 2×/s from a 1 s rolling average. When < 45 the text goes `--text-1` with a "▼" glyph. That's the "FPS-light". Toggle visibility with `F` key; visible by default.

### 6.6 Hint (bottom-left)
"Drag to orbit · Scroll to zoom · 1–5 bands · Esc unpin", 11px `--text-3`. Fades to 0 after the first interaction + 6 s.

---

## 7. Motion

### 7.1 Value smoothing (MUST)
Data arrives at ~10 Hz. The display interpolates at render rate with **frame-rate-independent exponential smoothing**:
`disp += (target − disp) * (1 − exp(−dt / τ))`, **τ = 0.12 s**. Applied to the *normalised* value per channel per band. Every band smooths continuously (not just the visible one), so switching is seamless. Sparklines draw raw µV², not smoothed.

### 7.2 Camera
- `PerspectiveCamera(fov 34, near 0.05, far 50)`. Home position = spherical (r 4.6, polar 62°, azimuth −35° — front-left 3/4 so the face and left hemisphere read). Target `(0, 0.05, 0)`. Fit: if aspect < 1, increase r so the head (radius ~1.25) fills ≤ 70% of min(viewport w, h).
- `OrbitControls`: `enableDamping`, `dampingFactor 0.08`, `enablePan false`, `minDistance 2.6`, `maxDistance 8`, `minPolarAngle 0.12`, `maxPolarAngle 1.95`, `rotateSpeed 0.7`, `zoomSpeed 0.8`.
- **Auto-rotate:** `autoRotateSpeed 0.5` (~2 min per revolution). Stops immediately on `controls 'start'`, a preset click, or hover-pin. Resumes after **8 s idle** by ramping the speed 0 → 0.5 over 1.5 s (easeInOutCubic). Off under reduced motion.
- **Intro (1.4 s):** camera dollies from r 6.2 → 4.6 with easeOutCubic; the heatmap fades in 0 → 1 over 800ms starting at 400ms; electrodes "switch on" staggered 30ms apart from front to back (each core 0 → value over 250ms). Skipped under reduced motion.

### 7.3 Ambient
- Only the stage grid, which is static. Electrode cores carry a very subtle shimmer: ±3% intensity at 0.3 Hz with a per-electrode phase, so a frozen stream still feels "powered". **Disabled when status is Stale/Disconnected**, because a frozen signal must look frozen.
- Background: CSS `radial-gradient(ellipse at 50% 42%, #10141a 0%, #0b0d10 45%, #07080a 100%)` behind a transparent canvas (`alpha:true`, `setClearColor(0x000000, 0)`). Note: bloom with an alpha canvas needs `OutputPass` and premultiplied handling. If bloom shows a black box, render the gradient as a full-screen background quad instead (scene.background = a CanvasTexture of the gradient). Either way the result must look identical.

---

## 8. Band switching transition (MUST)
On `change` of the band select (or key 1–5):
1. `uBandMix` 0 → 1 over **600ms easeInOutCubic**. The per-channel displayed value = `mix(dispOld[ch], dispNew[ch], e)`, which drives the heatmap, electrodes, bars and legend marker.
2. **Sweep** (SHOULD; signature moment): `uSweep` 0 → 1 over 700ms. In the shader, a soft brightening band (+12% luminance, width 0.18 in normalised z) travels anterior → posterior: `band = exp(-pow((dirZnorm − mix(1.1,−1.1,uSweep))/0.09, 2.0))`. It reads like a scanner pass. Under reduced motion: no sweep, 150ms crossfade.
3. Legend: title text crossfades (old out 150ms, new in 250ms, 4px vertical slide). Tick labels crossfade the same way with the new range. The gradient bar doesn't change (same colormap for every band, which is deliberate).
4. Band descriptor and table caption update. Status/aria: `aria-live` is **not** used for band changes; the select itself announces.
5. Rapid re-switching mid-transition: start the new transition from the *current mixed* values (no snapping).

---

## 9. Data layer (separate from rendering, MUST)

### 9.1 Modules (in one `<script type="module">`, but in clearly separated sections with banner comments)
```
// ===== DATA LAYER (no THREE imports below this line until RENDER LAYER) =====
const BANDS = ['delta','theta','alpha','beta','gamma'];
class DataSource extends EventTarget {        // emits 'frame' (detail: Frame) and 'status' (detail: {state, info})
  start(); stop(); get state();               // state ∈ 'mock'|'connecting'|'live'|'stale'|'disconnected'
}
class MockSource extends DataSource { constructor({channels, rateHz=10}) }
class WebSocketSource extends DataSource { constructor(url) }
class BandPowerStore {                        // the ONLY thing the renderer reads
  ingest(frame); channels(); raw(band,ch); norm(band,ch); history(band,ch) /* Float32 ring, 100 samples */;
  range(band) /* {lo,hi} µV² */; lockRange(bool);
}
// Frame = { t: seconds, bands: { [band]: { [channel]: µV² } } }
```
The renderer subscribes to nothing but the store (plus status events for the chip). Swapping Mock ↔ WS = `source.stop(); source = new X(); source.start()`. The store survives, but its history is cleared on source change.

### 9.2 WebSocket protocol (stub must be real, working code)
Accept all of these, normalising to `Frame`:
1. **Canonical:** `{"t": 1712345678.12, "bands": {"alpha": {"Fp1": 12.3, ...}, "beta": {...}, ...}}`
2. Single band: `{"band": "alpha", "values": {"Fp1": 12.3, ...}}`
3. Bare (brief's format): `{"Fp1": 12.3, "Fp2": 9.8, ...}`, assigned to the **currently selected band**.

Unknown channels are ignored, with a console.warn once per name. Channels missing from the montage table are not rendered. The montage on screen = the intersection of incoming channels and `MONTAGE`, recomputed if the set changes (which triggers a spline weight rebuild).

- Reconnect with backoff 1, 2, 4, 8, 10, 10… s. The chip shows the countdown.
- Stale: no frame for > 1000ms while open → state `stale`.
- Measured rate: EMA of inter-arrival times, shown in the chip.
- Include a commented Python bridge snippet in the file header (≤ 15 lines: `pylsl` + `websockets`, sends the canonical format at 10 Hz), so the LSL integration path is obvious.

### 9.3 Honest failure states (MUST)
- Disconnected / stale: values freeze at last-known. `uSat` → 0.35 over 600ms. Electrode HDR intensity capped at 1.0 (no bloom). Shimmer off. Centred overlay text above the head: "No signal" (13px `--text-2`) + "Last data {n}s ago". Never auto-switch to mock.
- Before the first frame arrives: the heatmap is hidden and electrodes are dim; the overlay says "Waiting for data…".

### 9.4 Normalisation
- Per band, keep a 20 s window (200 samples × channels) of raw values. Every 500ms compute the 2nd and 98th percentiles across all channels & samples, giving target `lo/hi`. Smooth `lo/hi` toward the targets with τ = 4 s (so the legend doesn't jitter). Guard `hi − lo ≥ 1e-6`.
- `norm = clamp((raw − lo) / (hi − lo), 0, 1)`.
- "Lock scale" freezes lo/hi.
- Legend ticks show `lo + p·(hi−lo)` for p ∈ {0, .25, .5, .75, 1}.

### 9.5 Mock generator (should look physiologically plausible)
- Per channel, per band: `raw = base[band] · spatial[band](ch) · (1 + 0.35·noise(t))`, where `noise` = 3-octave smooth 1D value/simplex noise at 0.07, 0.19, 0.47 Hz with weights 0.6/0.3/0.1, and a seed per channel+band.
- **Spatial correlation:** add a shared low-frequency component (0.05 Hz) weighted by electrode proximity, so neighbours co-vary. This makes the heatmap breathe in blobs, not salt-and-pepper.
- Base ranges (µV²): delta 15, theta 8, alpha 12, beta 3.5, gamma 0.6.
- Spatial priors: **alpha** ×2.2 at O1/O2, ×1.6 P3/P4/Pz, ×0.6 frontal. **Theta** ×1.5 Fz/F3/F4. **Beta** ×1.4 C3/C4/Cz. **Delta** ×1.8 Fp1/Fp2. **Gamma** ×1.5 at T7/T8/F7/F8 (muscle).
- **Events:** "eyes closed" alpha burst every 20–40 s (random). O1/O2/P3/P4 alpha ramps ×2.5 over 1.5 s, holds 4–6 s, decays over 2 s. Plus a blink every 4–7 s: Fp1/Fp2 delta spike ×3, 300ms. These give the demo a story.
- Emits the canonical frame at 10 Hz via `setInterval(100)`, with a little jitter (±8ms) so the smoothing is exercised.

---

## 10. Responsive & mobile
- **≥ 1100px:** layout as §6.
- **760–1099px:** channel panel collapses to a toggle button "Channels" (top-right under the chip) that opens it as an overlay drawer. The left panel stays.
- **< 760px (phone):**
  - Top bar: title (13px), status chip, FPS hidden.
  - Bottom sheet (panel style, full width minus 12px gutters, radius 12px top): band `<select>` (44px tall) + source segmented control. A "More" disclosure reveals view presets and the montage switch.
  - The legend sits directly above the sheet, full width minus 24px.
  - Channel table in a drawer from a "Channels" button. Rows 44px min height.
  - Camera fit uses the remaining viewport height (exclude sheet height).
  - Electrode labels: 9px is NOT allowed. Keep 10px, but show only labels whose screen-space distance to the nearest other label is > 28px. Hovered/pinned labels are always shown.
  - Pixel ratio cap 1.5. Bloom at quarter-res.
- No horizontal scroll at any width ≥ 320px. All touch targets ≥ 44×44px on coarse pointers (`@media (pointer:coarse)`).

---

## 11. Accessibility
- Text contrast ≥ 4.5:1 for all text (tokens above already pass on panel and hover surfaces). Legend tick labels ≥ 4.5:1 (`--text-2`).
- Band select is a native `<select>` with a `<label>`. Source is native radios. View buttons are `<button>`s with `aria-label`. Channel cells are `<button>`s inside a `<table>`.
- `:focus-visible` ring 2px `--focus`, offset 2px, on every control. Never `outline:none` without a replacement.
- Canvas: `role="img"` with `aria-label="3D head showing {band} band power across {N} EEG electrodes. See channel table for values."` (updated on band change).
- Value never by colour alone: the table has numbers, the heatmap has contour lines, the tooltip has numbers, status has icon + label.
- `prefers-reduced-motion` per §2.4.
- `forced-colors: active`: panels get `border:1px solid CanvasText`, bars get `background:Highlight`.

---

## 12. Performance budget (60 fps on a laptop iGPU, e.g. Intel Iris Xe at 1440×900, DPR 1.5)
| Item | Budget |
|---|---|
| Draw calls | ≤ 70 (19 electrodes × 3 visible meshes + head + wire + shell + neck + ears + grid). Instancing is allowed if needed, but not required. |
| Triangles | ≤ 60k at default quality (scalp shell detail 5 ≈ 20k culled to ~14k; head ~5k) |
| Pixel ratio | `min(devicePixelRatio, 1.75)` desktop, 1.5 mobile |
| Bloom | half-res (quarter on mobile) |
| Per-frame JS | ≤ 3 ms: spline mat-vec, smoothing, label occlusion, CSS2D update |
| DOM writes | Channel table, sparklines, tooltip, legend at **10 Hz** (on store ingest), not per frame. Bars via `transform` only. |
| Allocations | Zero per-frame allocations in the render loop (reuse vectors/colours) |
| Auto-degrade | If 1 s avg fps < 45 for 3 consecutive seconds: (1) disable bloom (halos remain), (2) pixel ratio → 1, (3) scalp shell → detail 4. One step per 3 s, never re-escalate within the session. Log each step to the console. |
| Hidden tab | Pause rendering on `visibilitychange` (data keeps ingesting) |
| Resize | Debounced 100ms; update renderer, composer, bloom, CSS2D, camera fit |

---

## 13. Code structure hints (single file, sectioned)
1. `<head>`: fonts, CSS tokens, layout CSS, importmap (`three`, `three/addons/`).
2. HTML overlay markup (title, panels, table shell, legend, chip, tooltip, overlays).
3. `<script type="module">`, sectioned:
   `CONFIG & TOKENS` → `MONTAGE` → `COLORMAP (lut)` → `DATA LAYER` (sources, store, mock) → `GEOMETRY` (shapeHead, head, ears, neck, shell, stage) → `SPLINE` → `ELECTRODES` → `POST` → `UI` (select, panel, legend, tooltip, chip) → `MOTION` (camera, transitions) → `LOOP` → `BOOT`.
4. The Python bridge comment at the top.

---

## 14. Design acceptance criteria (for the validation agent)

**Correctness**
- [ ] A1. Axes: nose points +Z, vertex is +Y. Fp1/F3/C3/P3/O1 have x < 0 (subject's left). The "L" marker is on the −X side.
- [ ] A2. All 10 default electrodes are placed per the §5.1 table (direction within 2° of listed vectors before deformation), symmetric L/R, on the scalp surface (not floating > 0.03, not buried).
- [ ] A3. With the 19-ch montage enabled, Fz/Cz/Pz/F7/F8/T7/T8/P7/P8 appear with **no code change beyond the montage table**. T7/T8 are not buried in the ears.
- [ ] A4. Heatmap colour at each electrode location matches that electrode's core colour (spline interpolates exactly). Spot check: hover a channel, compare swatch vs the scalp under it.
- [ ] A5. Heatmap covers the scalp above about the nasion–inion line, fades smoothly over θ 100–115°, and never paints eyes/face/ears/neck.
- [ ] A6. With 10 channels the temporal region is visibly lower-opacity (coverage mask), and the legend shows the "Low electrode coverage" key.
- [ ] A7. Colormap = exactly the 7 "Ember" stops. No rainbow, no per-band hue change. Legend gradient, heatmap, electrode cores, and bars all derive from the same `lut()`.
- [ ] A8. Legend shows the band name, unit µV², 5 ticks with real values that update when the auto-range moves. Values are 2 significant figures, first/last aligned to bar ends.
- [ ] A9. `toneMapping` is NoToneMapping (or the heatmap material has `toneMapped:false`). The heatmap does not bloom, and electrode cores do bloom more at higher values.

**Data layer**
- [ ] D1. Data code has no THREE references. The renderer reads only `BandPowerStore`.
- [ ] D2. WebSocket stub accepts all 3 message shapes (§9.2). It reconnects with backoff, and stale/disconnected states trigger the §9.3 visuals. It never auto-falls-back to mock.
- [ ] D3. Mock produces spatially smooth fields, the posterior alpha prior and periodic alpha bursts (observable within 45 s on Alpha).
- [ ] D4. Display smoothing is frame-rate independent (τ = 0.12 s). There is no visible 10 Hz stepping.

**UI / a11y**
- [ ] U1. Band control is a native `<select>` with a label, styled (no default OS look on Chromium), keyboard operable. Keys 1–5 work.
- [ ] U2. All text ≥ 10px. Text contrast ≥ 4.5:1 against its actual surface (check `--text-3` on `--panel-hover`).
- [ ] U3. Status chip shows Mock / Connecting / Live / Stale / Disconnected, each with icon + label. Changes are announced via aria-live.
- [ ] U4. FPS readout is present and updated about 2 Hz.
- [ ] U5. Hovering an electrode shows a tooltip (name, region, µV², % of range, sparkline) and highlights its table row. Hovering/focusing a row highlights the electrode. Esc unpins.
- [ ] U6. Labels on the far side of the head are hidden. No label is visible through the head.
- [ ] U7. Visible focus ring on every interactive element. Tab order: band → source → view → scale → channels.
- [ ] U8. At 375×812 no horizontal scroll, controls in a bottom sheet, targets ≥ 44px, head fully visible.

**Motion**
- [ ] M1. Auto-rotate is slow (≈2 min/rev), stops on interaction, and resumes after ~8 s idle with an eased ramp, not a jump.
- [ ] M2. Band switch crossfades over ~600ms (with sweep). Re-switching mid-transition doesn't snap.
- [ ] M3. `prefers-reduced-motion` disables auto-rotate, sweep, intro and shimmer.
- [ ] M4. None of the explicitly-out effects (§1) are present.

**Performance**
- [ ] P1. Steady ≥ 55 fps on an iGPU laptop at default quality; triangle and draw-call counts within §12 (`renderer.info`).
- [ ] P2. No per-frame allocations in the loop (no `new THREE.Vector3/Color` inside `animate`).
- [ ] P3. Auto-degrade steps trigger when fps is forced low (e.g. via CPU throttle), and are logged.
- [ ] P4. Console is clean (no errors/warnings except the documented unknown-channel warn).

---

## 15. Priority if the line budget gets tight
Cut in this order (last = keep at all costs): 2D extras → asymmetry index → legend hover marker → contour lines → sweep → view presets → montage toggle (keep the table-driven design) → sparklines in table (keep in tooltip). **Never cut:** spherical spline, coverage/boundary fade, honest disconnected state, native select, label occlusion, exact LUT colours, data/render separation.
