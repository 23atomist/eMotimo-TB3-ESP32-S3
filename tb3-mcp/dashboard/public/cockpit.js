// The cockpit's always-visible render path: telemetry (rig/tracking/
// services), the calibration badge, the at-a-glance health strip, and
// the aircraft list.
//
// DOM elements and the post adapter are injected via the constructor rather
// than reached for via document/window -- same pattern camera-panel.js
// already uses -- so this whole class can be pinned by vitest without a
// browser. See test/cockpit.test.ts.
//
// The AIM control is the behavioural point of this module: the virtual stick
// (virtual-stick.js, mounted in app.js) must mean something different
// depending on state -- a raw jog during tracking is silently overwritten by
// the tracker on its next tick, so a control labeled "jog" that does nothing
// is exactly the confusion this removes. aimMode(state) (ui-mode.js) is the
// single, pure source of truth for that decision; this class never
// re-derives it locally. stickMove()/stickRelease() route by mode; the
// arrow keys drive the same vector from app.js.
import { aimMode, calibrationBadge } from "./ui-mode.js";
import { renderVisionStatus } from "./vision-status.js";

function fmt(v, digits) {
  if (v === null || v === undefined) return "—"; // em dash for unavailable
  if (typeof v === "number") {
    return Number.isFinite(v) ? v.toFixed(digits === undefined ? 1 : digits) : "—";
  }
  return String(v);
}

function fmtBool(v) {
  if (v === null || v === undefined) return "—";
  return v ? "yes" : "no";
}

// Pairs two possibly-null numeric fields into "a° / b°", collapsing to a
// single "—" (rather than "—° / —°") when both are unavailable.
function fmtPair(a, b, unit, digits) {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return "—";
  return `${fmt(a, digits)}${unit} / ${fmt(b, digits)}${unit}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Renders one of the aircraft row's [Track]/[Sight] buttons. When `allowed`
// is false the button is disabled AND carries `reason` as its `title` --
// a greyed-out control with no explanation is exactly the defect this
// redesign exists to remove, so every disabled button here must say why.
function actionButton(cls, hex, label, allowed, reason) {
  const disabledAttr = allowed ? "" : " disabled";
  const title = allowed ? `${label} this aircraft` : reason;
  return `<button type="button" class="${cls}" data-hex="${escapeHtml(hex)}"${disabledAttr} title="${escapeHtml(title)}">${label}</button>`;
}

// Pure precondition-and-reason function for the per-aircraft-row [Track]/
// [Sight] buttons -- exported (not a Cockpit method) so it can be unit tested
// without constructing a Cockpit instance, and so its reasoning is auditable
// independent of the render path. See test/aircraft-row.test.ts.
//
// Three things that will silently break this if re-derived elsewhere:
//
// 1. row.trackable is null (unknown), not false, whenever the daemon can't
//    yet compute reachability -- no solved mount orientation means the
//    reachable/sunSafe/slewOk/inSector flags scanAircraft feeds into it are
//    all unanswerable (see deriveTrackable/AircraftRow in src/dashboard/
//    state.ts). null must read as "allowed, unknown" here, exactly like
//    calibrationBadge/aimMode never coerce a missing flag into a refusal.
//    Only a REAL false (the daemon evaluated this specific aircraft and it
//    failed one of those checks) disqualifies it.
// 2. Tracking is allowed under a PROVISIONAL (set_north_zero) orientation,
//    not only a fully solved one -- that's the entire point of the drift-
//    calibration bootstrap: track BEFORE a real solve exists, then trim and
//    record. track_aircraft's own daemon-side gate (rigR() ->
//    store.getOrientation(), calibration.ts) already accepts a provisional R
//    for exactly this reason; gating the button any tighter than the daemon
//    itself would disable the one control the bootstrap depends on.
// 3. sight_aircraft commands no motion, so its precondition is a known rig
//    location, not an orientation -- but that does NOT make it exempt from
//    E-STOP (a prior version of this comment claimed it was; it was wrong --
//    see review finding C-2). sight_aircraft records the rig's CURRENT
//    pan/tilt as the sighting, and E-STOP can halt a tracking slew wherever
//    it happens to land -- the instant it latches, the rig may no longer be
//    centred on the target it's supposedly sighting. That is a
//    DATA-VALIDITY concern, not an actuation one, and it's exactly the
//    reasoning procedure-actions.js's sightGateOk() already applies to the
//    drawer's [Sight it] strip button and app.js's physical-joystick Sight
//    button (both refuse under estopLatched||sunLocked) -- canSight below
//    must refuse identically, not just canTrack.
// 4. Sun-lock disqualifies BOTH buttons, not just Track. track_aircraft
//    (src/adsb-tools.ts) and sight_aircraft (src/geo-tools.ts) each check
//    supervisor.isSunLocked() and refuse identically -- sight_aircraft's
//    "no motion" exemption above is from an orientation requirement, not
//    from the sun guard, which can park the rig mid-drift-calibration under
//    a provisional orientation (src/track/supervisor.ts) -- exactly the
//    bootstrap window this feature exists for. A button that LOOKS
//    available and then fails with an unexplained server error is the same
//    defect ("a greyed control with no explanation") wearing a different
//    hat, so this must be caught here, not left to a failed POST.
// PURE: the order the operator picks a sighting target from.
//
// The daemon's scan_aircraft sorts NEAREST-FIRST, which is right for "what is
// closest" and wrong for "which of these can I actually see and sight". A
// plane 5km away at 3° elevation is behind the neighbours' roofline; one at
// 20km and 40° is overhead and holds still in frame. The operator's report
// (2026-07-29): "the planes it tracks are all very unfortunate and not even
// in sight... it always picks planes outside the arc", while good targets
// passed unused.
//
// So: trackable first (an untrackable row is not a candidate at all), then
// highest elevation, then longest remaining time in view as the tiebreak --
// a pass you can finish beats a pass you cannot. Nearest-first is kept as the
// final tiebreak so the order is total and stable.
//
// Sorts a COPY: the array comes off the SSE state, which other renderers
// (the radar) also read, and mutating shared state in a render path is how
// two views quietly disagree.
export function sortForPicking(rows) {
  const num = (v, fallback) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const at = a.trackable === true ? 0 : 1;
    const bt = b.trackable === true ? 0 : 1;
    if (at !== bt) return at - bt;
    const ae = num(a.elevation_deg, -Infinity);
    const be = num(b.elevation_deg, -Infinity);
    if (ae !== be) return be - ae;
    const as = num(a.est_track_sec, -Infinity);
    const bs = num(b.est_track_sec, -Infinity);
    if (as !== bs) return bs - as;
    return num(a.range_km, Infinity) - num(b.range_km, Infinity);
  });
}

// Is this list row the aircraft the rig is currently committed to?
//
// Pure and exported so the "which one am I following" decision is pinned by
// tests without a DOM (same pattern as aircraftRowActions below). The
// operator could not tell at a glance which row was live (field, 2026-08-19)
// -- the list is ordered for pickability, not proximity, so the tracked plane
// sits at no predictable position.
//
// `acquiring` counts: the rig is already committed to that aircraft and
// slewing to it, which is exactly when the operator most wants to see which
// one it picked. Any other state (stopped, waiting, parked) does not, even
// if a stale hex is still being reported alongside it.
const LIVE_TRACK_STATES = new Set(["tracking", "acquiring"]);

export function isTrackedRow(row, state) {
  const t = (state || {}).tracking;
  if (!t || !LIVE_TRACK_STATES.has(t.state)) return false;
  const rowHex = row && typeof row.hex === "string" ? row.hex : null;
  const trackedHex = typeof t.hex === "string" ? t.hex : null;
  if (rowHex === null || trackedHex === null) return false;
  // ICAO hex casing is not guaranteed to match across the feed and the
  // session, and a case mismatch would silently show nothing highlighted.
  return rowHex.toLowerCase() === trackedHex.toLowerCase();
}

export function aircraftRowActions(row, state) {
  const s = state || {};
  const cal = s.calibration || {};
  const hasOrientation = cal.calibrated === true || cal.provisional === true;
  const hasRigLocation = !!cal.rig;
  const estopped = s.estopLatched === true;
  const sunLocked = s.sunLocked === true;

  let canTrack = true;
  let trackReason;
  if (estopped) {
    canTrack = false;
    trackReason = "E-STOP latched";
  } else if (sunLocked) {
    canTrack = false;
    trackReason = "sun guard locked";
  } else if (!hasOrientation) {
    canTrack = false;
    trackReason = "not calibrated yet -- set north zero or finish calibration";
  } else if (row && row.trackable === false) {
    canTrack = false;
    trackReason = "not currently trackable (out of reach, in the sun, too fast, or outside the tracking sector)";
  }

  let canSight = true;
  let sightReason;
  if (estopped) {
    canSight = false;
    sightReason = "E-STOP latched -- the rig may no longer be centred on the target";
  } else if (sunLocked) {
    canSight = false;
    sightReason = "sun guard locked";
  } else if (!hasRigLocation) {
    canSight = false;
    sightReason = "rig location not set -- set the rig location first";
  }

  return { canTrack, trackReason, canSight, sightReason };
}

// panMul/tiltMul per direction -- inherited semantics from the retired four-
// button pad (left/right are swapped vs. the camera view). The arrow keys now
// drive the STICK vector through these same conventions (see app.js's
// KEY_TO_AXIS), so one sign table still governs every directional input.
export const DIRECTIONS = {
  "jog-up": { fx: 0, fy: -1 },
  "jog-down": { fx: 0, fy: 1 },
  "jog-left": { fx: -1, fy: 0 },
  "jog-right": { fx: 1, fy: 0 },
};

export class Cockpit {
  // deps:
  //   el -- app.js's own shared element map, passed through as-is (not a
  //     scoped subset built just for this class -- see app.js's `cockpit =
  //     new Cockpit({ el, ... })`). It therefore also carries elements this
  //     class has no business touching (estop, estopBanner, estopClear,
  //     camera*, cal*, sector*, joystick*, ...). Those are never read or
  //     written anywhere below -- this class only ever reaches into:
  //     mode, svc: { readsb, tb3mcp, tb3agent, llama },
  //     calBadge, health,
  //     rigConnected, rigPanTilt, rigMoving, rigBattery, rigTelemetryAge,
  //       rigImuPitchRoll, rigImuTP,
  //     trkState, trkTarget, trkAzEl, trkRange, trkError, trkLimits, trkOffset,
  //     visionStatus,
  //     adsbCount, adsbList,
  //     jog, jogMode, jogUp, jogDown, jogLeft, jogRight.
  //     Every element above is optional (checked before use) so a partial
  //     fake in a test, or a future markup trim, never throws. In
  //     particular: E-STOP (#estop/#estop-banner/#estop-clear) is present in
  //     `el` by reference but is never among the keys this class reads or
  //     writes -- E-STOP staying live under `locked` is enforced by this
  //     class simply never touching it, not by its absence from `el`.
  //   stickHold -- an already-constructed StickHold loop (stick-hold.js).
  //     Cockpit only ever calls .setVector()/.release()/.active on it --
  //     app.js owns its post/gate/onFailure wiring, exactly as it owns
  //     CameraPanel's WHEP session factory. The virtual stick (and the
  //     arrow keys, which drive the same vector) are the ONLY interactive
  //     motion inputs left in the cockpit; this class routes them by mode.
  constructor({ el, jogHold, nudgeHold, stickHold, post }) {
    this.el = el || {};
    this.jogHold = jogHold;   // legacy deps kept optional for old fakes; unused by the stick path
    this.nudgeHold = nudgeHold;
    this.stickHold = stickHold;
    this.post = post;

    // Last mode computed by render() -- "jog" | "trim" | "locked". Public:
    // app.js's keyboard/stick wiring reads this instead of keeping its
    // own second copy of "am I tracking" (see ui-mode.js's module doc on
    // why a local flag is exactly what must not exist).
    this.mode = "jog";

    // True between stickMove()/stickRelease(): whether THIS cockpit believes
    // the stick currently commands motion. Guards against a stray release
    // tearing down someone else's hold.
    this._stickHeld = false;
    // The last vector the stick reported, so a mode flip under a held finger
    // can re-issue it (see _renderAim's held-vector refresh below).
    this._lastVec = null;

    this._wireAdsbList();
  }

  // Called once per SSE tick with the full dashboard state.
  render(state) {
    const s = state || {};
    this._renderMode(s.mode);
    this._renderServices(s.services);
    this._renderRig(s.rig);
    this._renderTracking(s.tracking);
    this._renderVision(s.vision);
    this._renderAdsb(s);
    this._renderBadge(s);
    this._renderHealth(s);
    this._renderAim(s);
  }

  _renderMode(mode) {
    if (!this.el.mode) return;
    const m = mode ?? "idle";
    this.el.mode.textContent = "MODE: " + m.toUpperCase();
    this.el.mode.dataset.mode = m;
  }

  _renderServices(services) {
    const svc = this.el.svc;
    if (!svc) return;
    const s = services ?? {};
    for (const key of Object.keys(svc)) {
      const dot = svc[key];
      if (!dot) continue;
      const state = s[key] ?? "unknown";
      dot.className = "led led-" + state;
      dot.title = `${key}: ${state}`;
    }
  }

  _renderRig(rig) {
    const el = this.el;
    const r = rig ?? {};
    if (el.rigConnected) {
      el.rigConnected.textContent = fmtBool(r.connected);
      el.rigConnected.className = r.connected ? "ok" : "bad";
    }
    if (el.rigPanTilt) el.rigPanTilt.textContent = fmtPair(r.panDeg, r.tiltDeg, "°");
    if (el.rigMoving) el.rigMoving.textContent = fmtBool(r.moving);
    if (el.rigBattery) {
      el.rigBattery.textContent = r.batteryV === null || r.batteryV === undefined
        ? "—" : `${fmt(r.batteryV, 2)} V`;
    }
    if (el.rigTelemetryAge) {
      el.rigTelemetryAge.textContent = r.telemetryAgeMs === null || r.telemetryAgeMs === undefined
        ? "—" : `${r.telemetryAgeMs} ms`;
    }

    const imu = r.imu;
    if (imu && imu.ok) {
      if (el.rigImuPitchRoll) el.rigImuPitchRoll.textContent = fmtPair(imu.pitchDeg, imu.rollDeg, "°");
      if (el.rigImuTP) {
        const temp = imu.tempC === null || imu.tempC === undefined ? "—" : `${fmt(imu.tempC)}°C`;
        const press = imu.pressHpa === null || imu.pressHpa === undefined ? "—" : `${fmt(imu.pressHpa, 0)} hPa`;
        el.rigImuTP.textContent = `${temp} / ${press}`;
      }
    } else {
      if (el.rigImuPitchRoll) el.rigImuPitchRoll.textContent = "—";
      if (el.rigImuTP) el.rigImuTP.textContent = "—";
    }
  }

  // Telemetry-only: state/target/az-el/range/error/limits/offset text. The
  // AIM block's own jog-vs-trim label/styling is _renderAim's job now, not
  // this one -- aimMode(state) is the single source of truth for that,
  // never a locally-tracked "is tracking active" flag.
  _renderTracking(tracking) {
    const el = this.el;
    const t = tracking ?? {};
    if (el.trkState) el.trkState.textContent = t.state ?? "—";
    if (el.trkTarget) {
      el.trkTarget.textContent = t.hex ? `${t.callsign ?? t.hex} (${t.hex})` : "—";
    }
    if (el.trkAzEl) el.trkAzEl.textContent = fmtPair(t.targetAzDeg, t.targetElDeg, "°");
    if (el.trkRange) {
      el.trkRange.textContent = (t.targetRangeM === null || t.targetRangeM === undefined)
        ? "—" : `${fmt(t.targetRangeM, 0)} m`;
    }
    if (el.trkError) {
      el.trkError.textContent = (t.pointingErrorDeg === null || t.pointingErrorDeg === undefined)
        ? "—" : `${fmt(t.pointingErrorDeg)}°`;
    }

    if (el.trkLimits) {
      const badges = [];
      if (t.panLimited) badges.push("PAN LIMITED");
      if (t.tiltLimited) badges.push("TILT LIMITED");
      // Riding prediction (estimator coasting through a report gap). Normal
      // in passing at 1Hz; worth watching only when it sticks for seconds.
      const coasting = !!t.coasting;
      if (coasting && !(t.panLimited || t.tiltLimited)) badges.push("COASTING");
      el.trkLimits.textContent = badges.length ? badges.join(", ") : "none";
      // Limited axes are a fault-adjacent state (red); coasting alone is only
      // informational (amber).
      el.trkLimits.className = (t.panLimited || t.tiltLimited) ? "bad" : coasting ? "warn" : "ok";
    }

    // The drift-calibration measurement in progress (track/offset.ts).
    // Always a number (mergeState defaults it to 0), so this always reads as
    // a real, converging value rather than a dash.
    if (el.trkOffset) {
      const panOff = typeof t.offsetPanDeg === "number" ? t.offsetPanDeg : 0;
      const tiltOff = typeof t.offsetTiltDeg === "number" ? t.offsetTiltDeg : 0;
      el.trkOffset.textContent = fmtPair(panOff, tiltOff, "°", 2);
      el.trkOffset.className = (panOff !== 0 || tiltOff !== 0) ? "warn" : "";
    }
  }

  // Vision-lock correction loop readout (get_vision_status via state.vision,
  // see src/dashboard/state.ts). renderVisionStatus (vision-status.js) is the
  // single source of truth for the text -- this method only maps
  // state.vision's field names onto the {enabled, readOnly, lastOutcome,
  // panDeg, tiltDeg} shape that function expects and paints it. Deliberately
  // NOT folded into _renderTracking above: vision-lock is its own subsystem
  // (can run with tracking stopped, e.g. read-only observation passes), and
  // keeping it a separate method/element means a future drawer entry for
  // vision detail (focalPx/latencyMs/detectorReachable) has one obvious place
  // to hang off of.
  _renderVision(vision) {
    if (!this.el.visionStatus) return;
    const v = vision ?? {};
    this.el.visionStatus.textContent = renderVisionStatus({
      enabled: v.enabled ?? false,
      readOnly: v.readOnly ?? true,
      lastOutcome: v.lastOutcome ?? null,
      panDeg: v.lastCorrectionPanDeg ?? null,
      tiltDeg: v.lastCorrectionTiltDeg ?? null,
    });
  }

  // Renders from adsb.aircraft (every plane scanAircraft sees, geometry-only
  // once a rig location exists), NOT adsb.trackable -- adsb.trackable is a
  // separate, narrower only_trackable:true scan that requires calibration and
  // errors without it (see scan_aircraft's own description in src/adsb-
  // tools.ts), so pre-calibration it is empty and would leave this list, and
  // therefore [Track], with nothing to show on exactly the bootstrap pass
  // that needs it. aircraftRowActions (above) is the single place that turns
  // each row's trackable/calibration/E-STOP state into the two buttons'
  // enabled-ness and reason text; this method never re-derives that itself.
  _renderAdsb(state) {
    const el = this.el;
    if (!el.adsbList) return;
    // Never rewrite the list out from under a finger that is already down on
    // it. Delegation alone does NOT fix the swallowed press (see
    // _wireAdsbList): if the mousedown target is detached before mouseup, the
    // browser synthesizes no `click` AT ALL -- a click is only raised on the
    // nearest common ancestor of the two targets, and a detached node has no
    // in-tree ancestor -- so there is no event for any listener, delegated or
    // not, to hear. The only fix is to not replace the node mid-press.
    // Deferring costs at most one tick (~1s); the release repaints on the
    // next one.
    if (this._adsbPressed) return;
    const s = state || {};
    const a = s.adsb ?? { rawCount: null, aircraft: [] };
    // Ordered for pickability, not proximity -- see sortForPicking.
    const rows = sortForPicking(a.aircraft);
    if (el.adsbCount) {
      // Same "N trackable / M seen" stat the header always showed -- just
      // counted off the full row list (only a real, non-null true counts)
      // now that the list itself is no longer the pre-filtered array.
      const trackableCount = rows.filter((row) => row.trackable === true).length;
      el.adsbCount.textContent = a.rawCount === null || a.rawCount === undefined
        ? `(${trackableCount} trackable)`
        : `(${trackableCount} trackable / ${a.rawCount} seen)`;
    }

    if (rows.length === 0) {
      el.adsbList.innerHTML = '<div class="list-empty">no aircraft in range</div>';
      return;
    }

    el.adsbList.innerHTML = rows.map((row) => {
      const label = escapeHtml(row.callsign || row.hex);
      const alt = row.altitude_m === null || row.altitude_m === undefined ? "—" : `${Math.round(row.altitude_m)} m`;
      const gs = row.ground_speed_kt === null || row.ground_speed_kt === undefined ? "—" : `${Math.round(row.ground_speed_kt)} kt`;
      const est = row.est_track_sec === null || row.est_track_sec === undefined ? "—" : `${Math.round(row.est_track_sec)}s`;
      const actions = aircraftRowActions(row, s);
      const trackedClass = isTrackedRow(row, s) ? " adsb-row-tracking" : "";
      return `
        <div class="adsb-row${trackedClass}" data-hex="${escapeHtml(row.hex)}">
          <div class="adsb-main">
            <span class="adsb-label" title="alt ${alt}, gs ${gs}, cat ${escapeHtml(row.category ?? "—")}, sqk ${escapeHtml(row.squawk ?? "—")}">${label}</span>
            <span class="adsb-actions">
              ${actionButton("track-btn", row.hex, "Track", actions.canTrack, actions.trackReason)}
              ${actionButton("sight-btn", row.hex, "Sight", actions.canSight, actions.sightReason)}
            </span>
          </div>
          <div class="adsb-meta">
            az ${fmt(row.azimuth_deg, 0)}° / el ${fmt(row.elevation_deg, 0)}°
            &middot; ${fmt(row.range_km, 1)} km
            &middot; ${est}
          </div>
        </div>`;
    }).join("");
  }

  // Delegated (not per-button) click handling for the aircraft list's
  // [Track]/[Sight] buttons -- wired ONCE here (from the constructor) on the
  // stable #adsb-list container, which _renderAdsb above only ever rewrites
  // the innerHTML of, never recreates itself. Before this fix, a fresh
  // per-button addEventListener call was attached after EVERY render() tick
  // (this list re-renders at ~1Hz, driven by live, jittering ADS-B data) --
  // a press whose pointerdown/pointerup straddled a tick landed on a button
  // element that had just been detached and replaced, so its (old) listener
  // never fired: no POST, no toast, no console error, just a silently
  // swallowed click (measured at ~8% of human-length presses at random
  // phase, and 8/8 of presses deliberately held across a tick -- review
  // finding C-3). Delegation is necessary but NOT sufficient: it removes the
  // per-tick listener churn and gives the surviving listener a stable home,
  // but a delegated listener still hears nothing when no `click` is
  // synthesized. The pointer-down guard in _renderAdsb is what actually
  // closes the swallow; the two work together.
  //
  // pointerup/pointercancel are bound on `window`, not on the list, so a
  // press that drags off the row before releasing still clears the guard --
  // otherwise a single such gesture would freeze the list forever.
  _wireAdsbList() {
    const list = this.el.adsbList;
    if (!list) return;
    this._adsbPressed = false;
    list.addEventListener("pointerdown", () => { this._adsbPressed = true; });
    // Clear the guard and STOP. Repainting here would re-break the very thing
    // this fixes: `click` is synthesized after pointerup, so a re-render
    // inside this handler detaches the node before the click is raised and
    // the press is swallowed again -- measured, not theorised. The next SSE
    // tick (<=1s) repaints, which is soon enough for a range readout.
    const release = () => { this._adsbPressed = false; };
    // Bound on the window when there is one, so a press that drags OFF the
    // row before releasing still clears the guard -- otherwise one such
    // gesture freezes the aircraft list for good. The list-level pair is the
    // fallback for environments with no window (the unit-test DOM harness),
    // and is a harmless duplicate in a browser since release is idempotent.
    const win = typeof window !== "undefined" ? window : null;
    if (win && typeof win.addEventListener === "function") {
      win.addEventListener("pointerup", release);
      win.addEventListener("pointercancel", release);
    }
    list.addEventListener("pointerup", release);
    list.addEventListener("pointercancel", release);
    list.addEventListener("click", (evt) => {
      const trackBtn = evt.target.closest("button.track-btn");
      if (trackBtn) {
        if (trackBtn.disabled) return; // defense in depth -- a disabled button shouldn't fire this at all
        this.post("track", { hex: trackBtn.dataset.hex });
        return;
      }
      const sightBtn = evt.target.closest("button.sight-btn");
      if (sightBtn) {
        if (sightBtn.disabled) return;
        this.post("calibrate/sight-aircraft", { hex: sightBtn.dataset.hex });
      }
    });
  }

  _renderBadge(state) {
    if (!this.el.calBadge) return;
    const b = calibrationBadge(state);
    this.el.calBadge.textContent = b.text;
    this.el.calBadge.className = "badge " + b.cls;
  }

  // At-a-glance rig/sun-guard/services health, reusing the same led-*
  // classes the service dots already use (style.css) -- no new CSS needed.
  // Not spelled out field-by-field in the brief, but the design's own
  // topbar sketch shows exactly this glance ("rig ●  sun ●  svc ●") next to
  // the calibration badge -- see docs/superpowers/specs/2026-07-28-
  // dashboard-redesign-design.md's layout diagram.
  _renderHealth(state) {
    const el = this.el.health;
    if (!el) return;
    const rig = state.rig ?? {};
    const services = state.services ?? {};
    const sunGuard = state.sunGuard ?? {};

    const rigCls = rig.connected ? "led-active" : "led-failed";

    // "inactive" is NOT a fault -- tb3agent reads "inactive" whenever
    // Autonomous mode is simply off, which is the default, entirely healthy
    // state during ordinary manual tracking (ServiceState, state.ts). A dot
    // that reads the same for "off on purpose" and "actually failed" trains
    // the operator to ignore it -- this project has already shipped that
    // exact mistake twice (a permanently-amber "capture skipped" chip, a
    // permanently-red "capture ERROR"), and both were treated as real
    // defects. So: any genuine "failed" always wins: red. Otherwise any
    // genuinely "unknown" (not yet polled, daemon unreachable) reads as
    // unknown -- distinct from both healthy and failed. Everything else
    // (all active, or a mix of active/deliberately-inactive) is healthy.
    const svcStates = Object.values(services);
    const svcCls = svcStates.length === 0
      ? "led-unknown"
      : svcStates.some((v) => v === "failed")
        ? "led-failed"
        : svcStates.some((v) => v === "unknown")
          ? "led-unknown"
          : "led-active";

    const sunCls = sunGuard.state === "unknown" || sunGuard.state === undefined
      ? "led-unknown"
      : sunGuard.locked
        ? "led-failed"
        : sunGuard.enabled
          ? "led-active"
          : "led-inactive";

    el.innerHTML =
      `<span class="led ${rigCls}" title="rig: ${rig.connected ? "connected" : "disconnected"}"></span>rig ` +
      `<span class="led ${sunCls}" title="sun guard: ${escapeHtml(sunGuard.state ?? "unknown")}"></span>sun ` +
      `<span class="led ${svcCls}" title="services"></span>svc`;
  }

  // -- AIM control (virtual stick) ----------------------------------------
  //
  // The label and the stick's behaviour both come from aimMode(state) --
  // never re-derived from a local flag. "locked" always wins over "trim"
  // (aimMode checks E-STOP/sun-lock before tracking state; see ui-mode.js)
  // -- this method must not reorder that itself either, it simply renders
  // whatever aimMode already decided. The widget's own dimming is app.js's
  // job (stick.setDisabled on the same gate), so a locked rig here means:
  // halt the hold and relabel.
  _renderAim(state) {
    const mode = aimMode(state);
    this.mode = mode;
    const el = this.el;

    if (mode === "locked") {
      const reason = this._lockReason(state);
      if (el.jogMode) {
        el.jogMode.textContent = `LOCKED — ${reason}`;
        el.jogMode.classList.remove("jog-mode-label-trim");
        el.jogMode.classList.add("bad");
      }
      this._haltStickUnconditionally();
      return;
    }

    if (mode === "trim") {
      const t = state.tracking || {};
      const panOff = typeof t.offsetPanDeg === "number" ? t.offsetPanDeg : 0;
      const tiltOff = typeof t.offsetTiltDeg === "number" ? t.offsetTiltDeg : 0;
      if (el.jogMode) {
        el.jogMode.textContent = `TRIM ${fmtPair(panOff, tiltOff, "°", 2)}`;
        el.jogMode.classList.add("jog-mode-label-trim");
        el.jogMode.classList.remove("bad");
      }
    } else {
      if (el.jogMode) {
        el.jogMode.textContent = "JOG";
        el.jogMode.classList.remove("jog-mode-label-trim", "bad");
      }
    }

    // A tracking session can start (or end) UNDER a held stick -- the finger
    // is down, no further pointermove fires, and the hold would keep posting
    // under the OLD mode indefinitely: a raw jog rate riding straight into
    // what is now a tracking session. Re-issue the held vector under the
    // CURRENT mode every tick; StickHold treats a same-mode re-issue as a
    // value refresh (no timer churn) and a mode flip as a clean restart.
    if (this._stickHeld && this._lastVec) {
      this.stickHold.setVector(mode, this._lastVec.fx, this._lastVec.fy);
    }
  }

  // A finger-down move of the virtual stick (or an arrow key held down, which
  // drives the same fractional vector). fx/fy are the ALREADY-SHAPED
  // deflections from virtual-stick.js (-1..1; screen convention: left is -x,
  // up is -y). Routing is purely by this cockpit's current mode: jog posts a
  // live-proportional rate vector; trim repeats proportional aim-offset
  // nudges. Locked refuses outright -- the keyboard has no [disabled] to stop
  // it, so this is the defense-in-depth path for both inputs.
  stickMove(fx, fy) {
    if (this.mode === "locked") return;
    this._lastVec = { fx, fy };
    this.stickHold.setVector(this.mode === "trim" ? "trim" : "jog", fx, fy);
    if (!this.stickHold.active) return; // refused: gated at the hold's own level
    this._stickHeld = true;
  }

  // Finger up / key up. Only ends the push if THIS cockpit started it.
  stickRelease() {
    if (!this._stickHeld) return;
    this._stickHeld = false;
    this._lastVec = null;
    this.stickHold.release();
  }

  // "locked" doesn't say *why* -- aimMode collapses E-STOP and sun-lock to
  // the same value on purpose (the AIM block only needs "can I move right
  // now", not the reason, to pick a mode) -- so the reason is derived here,
  // independently, the same way app.js's sun-banner text already is.
  _lockReason(state) {
    if (state && state.estopLatched) return "E-STOP";
    const sg = (state && state.sunGuard) || {};
    if (sg.separationDeg === null || sg.separationDeg === undefined) {
      return sg.state ? `sun lock (${sg.state})` : "sun lock";
    }
    return `sun lock, separation ${fmt(sg.separationDeg, 1)}°`;
  }

  // Halts the stick hold regardless of who believes they own it -- for the
  // "a press can end without telling the control that started it" triggers
  // (window blur, tab hidden) and the locked transition. Both legacy hold
  // classes are stopped too, so a caller still holding a pre-stick reference
  // can never leave motion running.
  stopHoldUnconditionally() {
    this._haltStickUnconditionally();
  }

  _haltStickUnconditionally() {
    this._stickHeld = false;
    if (this.stickHold) this.stickHold.release();
    if (this.jogHold) this.jogHold.stop?.();
    if (this.nudgeHold) this.nudgeHold.stop?.();
  }
}
