# 3D Rig View — Design

**Status:** design, approved 2026-07-24. Follow-on to the ADS-B mini-map.
Independent of the IMU-calibration PR #7.

## Problem / goal

Give the operator a live 3D model of the rig showing its actual pan/tilt posture
and where the camera is aimed — a spatial "what is the rig doing right now" view
to complement the numeric telemetry and the 2D radar.

## Scope

- **In scope:** a schematic 3D model of the eMotimo TB3 (tripod/base, pan
  turntable, tilt yoke + camera) posed live from `rig.panDeg`/`rig.tiltDeg`, with
  a boresight arrow out of the camera, orbit-to-look-around, driven by the
  existing SSE `DashboardState`.
- **Out of scope (v1):** leaning the base by the IMU pitch/roll; a target-direction
  line to the tracked aircraft; photorealistic geometry. All are easy later adds.

## Approach — plain Three.js, no build step

Three.js ships as native ES modules, so it loads directly in the (already
`type="module"`) vanilla dashboard with **no bundler**:

- **Vendor** `three.module.js` (the core ESM build, ~600 KB) and the
  `OrbitControls` addon (`examples/jsm/controls/OrbitControls.js`) into
  `dashboard/public/vendor/` (committed). Pin a specific Three.js release (e.g.
  r0.16x) and record the version in a comment/README so it's reproducible.
- **Import map** in `index.html` so the addon's bare `import … from "three"`
  resolves to the vendored core:
  ```html
  <script type="importmap">{ "imports": { "three": "./vendor/three.module.js" } }</script>
  ```
- This is the **one deliberate exception** to the dashboard's no-vendored-deps
  rule (the operator approved the Three.js dependency for real 3D). Everything
  else stays hand-rolled.

## The model (`dashboard/public/rigview.js`, an ES module)

A `RigView` that owns a Three.js `Scene`/`Camera`/`Renderer` bound to a
`<canvas>`, built from primitives:

- **Base/tripod:** fixed, level — a simple tripod (three legs or a cylinder
  column + feet) at the origin.
- **Ground + orientation:** a faint `GridHelper` and short XYZ axes + a **north
  label**, so the pan angle is readable in world space.
- **Pan turntable:** a `Group` rotated about the vertical (world-up) axis by
  `panDeg` — the head sits on it.
- **Tilt yoke + camera:** on the turntable, a small yoke/arm + a camera box + a
  short lens cylinder, tilted about the horizontal tilt axis by `tiltDeg`.
- **Boresight arrow:** an `ArrowHelper` from the lens along the camera's forward
  axis — the visual payoff (where it's pointed). Length fixed/schematic.
- **Lighting:** an `AmbientLight` + one `DirectionalLight` so surfaces read as 3D;
  background matches the dashboard theme.

`RigView` exposes: `constructor(canvas)`, `update(rig)` (set turntable/tilt
rotations from `rig.panDeg`/`rig.tiltDeg`, degrees→radians; handle `null`), and
`dispose()`.

## Interaction

`OrbitControls` on the renderer: drag-orbit, scroll-zoom, with a sensible default
3/4 view on load. Render on `requestAnimationFrame` while orbiting or animating a
pose change; otherwise idle (don't burn a rAF loop when nothing moves — re-render
on `controls.change` and on each `update()`).

## Data flow

The existing SSE loop already delivers `state.rig.{panDeg,tiltDeg,connected,
telemetryAgeMs}`. `render(state)` (app.js) calls `rigView.update(state.rig)` each
tick. app.js constructs the `RigView` once at startup (after the canvas exists),
like the other widgets. No new backend/daemon work — this is purely frontend
reading state that's already streamed.

## Sign / handedness

`rig.panDeg`/`rig.tiltDeg` are the **user-frame** degrees the operator commands
(the daemon applies `panSign`/`tiltSign` before reporting). The model rotates the
turntable/arm by those values directly (deg→rad); the rotation sign is chosen so
the visual turns the way the operator expects (verified on-host — it's a
schematic, so consistency with the controls matters, not real-world absolute
handedness).

## Error handling

- `rig.panDeg`/`tiltDeg` `null` (rig disconnected / not polled) → the model holds
  at 0/0 and dims subtly ("no telemetry"); never throws.
- Stale telemetry (`telemetryAgeMs` large) → optional subtle staleness cue
  (reuse the dashboard's existing staleness convention if there is one; else skip).
- WebGL unavailable (rare) → `RigView` catches the context-creation failure and
  shows a small "3D unavailable" placeholder instead of throwing.

## Testing

- **Unit (vitest):** only the pure helper `panTiltToRotation(panDeg, tiltDeg)` (or
  a boresight-direction vector) if it's cleanly isolable — a couple of assertions
  (0/0 → identity/expected axes; a known pan/tilt → expected radians/vector). Do
  NOT manufacture trivial deg→rad tests or test Three.js itself.
- **On-host manual (no automated E2E, per dashboard convention):** the model
  renders; panning the rig (jog) turns the turntable the correct way; tilting
  raises/lowers the camera + boresight arrow; orbit-drag and zoom work; a
  disconnected rig dims to the neutral pose.

## Files

- Create: `dashboard/public/rigview.js` (the `RigView` module), `dashboard/public/vendor/three.module.js`
  + `dashboard/public/vendor/OrbitControls.js` (vendored, pinned version),
  optionally `dashboard/public/rigmath.js` (the pure `panTiltToRotation` helper) +
  `test/rigview-math.test.ts`.
- Modify: `dashboard/public/index.html` (the import map + a `<canvas>` panel +
  the rig-view panel), `dashboard/public/app.js` (construct `RigView`, call
  `update` in the render loop), `dashboard/public/style.css` (panel/canvas styling).
- A short note (README or a comment) recording the pinned Three.js version + where
  the vendored files came from.
