# EEG Three.js Visualiser — Context Dump

Paused 2026-10-24. This file is everything needed to pick the project back up.

## Goal (user's brief)
Build a single `index.html` using Three.js from a CDN that shows EEG band power on a 3D head:
- A stylised low-poly head, built in code (procedural or sphere-based). No external models.
- Electrodes at 10-20 positions Fp1 Fp2 F3 F4 C3 C4 P3 P4 O1 O2, each glowing by band power. A dropdown picks alpha, beta, theta or gamma.
- A separate data layer:
  - starts with a mock generator (smooth noise per channel);
  - has a clear stub to swap in a WebSocket feed sending JSON `{channel: value}` at about 10 Hz.
- An interpolated scalp heatmap between the electrodes.
- Orbit controls, a dark background and a readable legend.
- Keep data separate from rendering, so it can be wired to LSL later through `bridge.py`.
- `bridge.py` uses pylsl and websockets, with explicit loops and no clever one-liners.
- Test in a browser, fix console errors, then summarise how to switch from mock to live data.

**Process the user asked for:** a team of agents (a coding agent, a design agent and a validation agent) that are critical of each other. Use design and dataviz plugins and skills to raise the visual quality. The user wants it "really really impressive".

## Status

| Item | State |
|---|---|
| `bridge.py` | **Done and verified** (see below) |
| `team/DESIGN_SPEC.md` | **Done.** Written by the design agent. |
| `team/BRIDGE_NOTES.md` | **Done.** The wire-contract caveats the front-end must handle. |
| `index.html` | **Not started.** The coding agent was stopped before writing it. |
| Validation pass (browser, console errors) | Not started |
| Design critique of screenshots | Not started |
| Final "mock → live" summary for the user | Not started |

## Files
- `bridge.py`: LSL → WebSocket bridge.
- `team/DESIGN_SPEC.md`: the full visual spec. Read it before building.
- `team/BRIDGE_NOTES.md`: front-end gotchas taken from the bridge.
- `team/test_client.py`: WebSocket test client. It checks the message rate and schema.
- `team/fake_outlet.py`: a fake 10-channel, 256 Hz LSL EEG outlet for live-path testing.
- `team/*.log`: logs from the bridge test runs.

## bridge.py summary
- Install with `pip install pylsl websockets numpy`. Already installed: pylsl 1.18.6, websockets 17.3, numpy 1.26.4. Playwright was also installed for browser testing.
- Run it:
  - `python bridge.py --mock`: synthetic EEG, no hardware or pylsl needed.
  - `python bridge.py`: finds the LSL stream of type EEG.
  - Other options: `--stream-name X`, `--host`, `--port 8765`, `--rate 10`, `--window 2`, `--relative`, `--flat-band alpha`, `--channels Fp1,...`, `--timeout`.
- How it works:
  - A reader thread (LSL `pull_chunk` or the mock generator) fills a ring buffer with one deque per channel.
  - An asyncio loop computes a Welch PSD (numpy, Hann window, 1 s segments with 50% overlap) and broadcasts to every connected client.
  - It uses the modern `websockets.asyncio.server` API and falls back to the legacy one.
- Verified:
  - The maths is right: a 10 Hz sine of amplitude 10 gives alpha = 50.0.
  - It sends at about 10 Hz in mock, flat and relative modes.
  - A real LSL stream from the fake outlet is picked up correctly.
  - When one of two clients disconnects, the other keeps receiving.
  - A missing stream gives a clear error and exit code 1.
- Not verified: Ctrl+C shutdown. The handler code is written but untested on Windows.

### Wire contract
- **Full form** (default): `{"type":"bandpower","t":<unix s>,"units":"uV^2"|"relative","bands":{"delta":{ch:v},"theta":{...},"alpha":{...},"beta":{...},"gamma":{...}}}`
- **Flat form** (`--flat-band alpha`): `{"Fp1":0.42,...}`, applied to the currently selected band.
- To tell them apart, check `msg.type === "bandpower"`.
- Bands (Hz): delta 1–4, theta 4–8, alpha 8–13, beta 13–30, gamma 30–45.

### Front-end must handle (from BRIDGE_NOTES)
- Absolute µV² values run from about 0.01 to over 800, and delta dominates. Normalise per band using an adaptive range. Never hard-code 0..1, except in `--relative` mode.
- Take the channel names from the message keys. Unknown names (TP9, AF7, Ch1…) must not crash the page.
- Reconnect automatically with backoff. The bridge sends nothing until it has 1 s of data buffered.
- A dropped connection shows frozen, greyed values. Never fall back to mock data on its own.

## Design spec key decisions (team/DESIGN_SPEC.md)
- **Look:** a dark "lab instrument" style rather than gamer neon. The head and UI are greyscale; colour is used only for the data.
- **Colour scale "Ember":** 7 amber stops, from #663b26 to #fdecd1. It was checked with the dataviz validator. A single `lut()` colours the heatmap, electrodes, bars and legend, with no tone mapping.
- **Heatmap:** spherical spline (Perrin), not simple distance weighting. It fades below the scalp line and where no electrode is nearby.
- **Electrodes:** 10-20 positions are given as a table of angles and 3D vectors. Adding the 19-channel set only means adding rows.
- **Head orientation:** nose = +Z, top = +Y, left hemisphere = −X.
- **Glow:** bloom is limited to the electrode cores so it doesn't change the heatmap colours.
- **UI:**
  - a styled native `<select>`;
  - a status chip showing Mock / Connecting / Live / Stale / Disconnected;
  - a left/right mirrored channel table, which doubles as the accessible table view;
  - text contrast of at least 4.5:1.
- The spec ends with **25 acceptance checks** and a list of what to cut first if the file gets too long.
- **Open concern** (raised by the orchestrator): a single amber hue may look flat against the "really impressive" bar. The coding agent may deviate if it writes down a reason.

## UPDATE (later, same day) — round 1 done, round 2 interrupted
- index.html v1 built (coder), reviewed: team/VALIDATION_REPORT.md, team/DESIGN_REVIEW.md (+ team/design_proto.diff, shot_design_proto_*.png).
- Round 2 fix pass was STOPPED mid-way: index.html is partially edited (1638 lines, JS syntax-checks OK, not browser-tested, CODER_NOTES not updated). Unknown which fixes landed — diff against design_proto.diff / grep before continuing.
- Round 2 fix list (priority): B1 mirror (subject left = +X: negate X in m.dir, swap L/R markers+views, flip key light); design P0 head restyle + near-profile camera + cap back-facing core bloom; M1 spline lambda 1e-5 -> 1e-7; M2 per-channel staleness; M3 case-insensitive channel names; M4 flat mode must not relabel alpha as other bands; P1 polish (O1 font, clip-aware range, coverage edge, 2D inset).
- After that: validation re-run (team/validation/ scripts) + design re-check.

## Next steps (original plan)
1. **Front-end coding agent**:
   - Build `index.html` from DESIGN_SPEC.md and BRIDGE_NOTES.md.
   - Pin the Three.js version in an importmap, e.g. three@0.169.0 from jsdelivr, using OrbitControls, EffectComposer/UnrealBloomPass and CSS2DRenderer.
   - Mark the code sections clearly: DATA LAYER / NORMALISATION / RENDERING / UI.
   - The data layer has the interface `start/stop/onFrame/onStatus`, with `MockSource`, `WebSocketSource` and a `createSource()` that reads `?source=ws&url=ws://localhost:8765`.
   - Write any deviations from the spec in `team/CODER_NOTES.md`.
   - Self-test with `python -m http.server 8000` and a Playwright script (console messages, page errors, screenshots per band, live run against `bridge.py --mock`).
2. **Validation agent**:
   - Run the page in a real browser with Playwright, plus claude-in-chrome if it's available.
   - Collect console errors, and test resize, a WebSocket kill and restart, and unknown channels.
   - Check all 25 acceptance criteria and that electrodes are placed correctly.
   - Be critical, and report failures back to the coder.
3. **Design agent**: critique the screenshots against the spec using the design-critique skill, and push back on the coder's deviations.
4. Iterate coder ↔ reviewers until there are no console errors and the acceptance checks pass.
5. Final reply to the user: how to switch from mock to live, i.e. run `python bridge.py` (or `--mock` to test), then open `index.html?source=ws&url=ws://localhost:8765`.
