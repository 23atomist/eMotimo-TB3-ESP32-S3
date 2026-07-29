// The cockpit's always-visible render path: telemetry (rig/tracking/
// services), the calibration badge, the at-a-glance health strip, the
// aircraft list, and the AIM block (the four direction buttons).
//
// DOM elements and the post adapter are injected via the constructor rather
// than reached for via document/window -- same pattern camera-panel.js
// already uses -- so this whole class (including the AIM block's mode
// switch and its press-and-hold wiring) can be pinned by vitest without a
// browser. See test/cockpit.test.ts.
//
// The AIM block is the behavioural point of this module: the same four
// direction buttons must mean something different depending on state, and
// the label must always agree with what they actually do -- a raw jog
// during tracking is silently overwritten by the tracker on its next tick,
// so a control labeled "jog" that does nothing is exactly the confusion
// this removes. aimMode(state) (ui-mode.js) is the single, pure source of
// truth for that decision; this class never re-derives it locally.
import { aimMode, calibrationBadge } from "./ui-mode.js";

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

// panMul/tiltMul per direction -- unchanged from app.js's original
// JOG_SOURCES (left/right are swapped vs. the camera view, same as before).
const DIRECTIONS = {
  "jog-up": { panMul: 0, tiltMul: 1, elKey: "jogUp" },
  "jog-down": { panMul: 0, tiltMul: -1, elKey: "jogDown" },
  "jog-left": { panMul: 1, tiltMul: 0, elKey: "jogLeft" },
  "jog-right": { panMul: -1, tiltMul: 0, elKey: "jogRight" },
};

export class Cockpit {
  // deps:
  //   el -- the DOM elements this class owns (never reached for globally):
  //     mode, svc: { readsb, tb3mcp, tb3agent, llama },
  //     calBadge, health,
  //     rigConnected, rigPanTilt, rigMoving, rigBattery, rigTelemetryAge,
  //       rigImuPitchRoll, rigImuTP,
  //     trkState, trkTarget, trkAzEl, trkRange, trkError, trkLimits, trkOffset,
  //     adsbCount, adsbList,
  //     jog, jogMode, jogUp, jogDown, jogLeft, jogRight.
  //     Every element is optional (checked before use) so a partial fake in
  //     a test, or a future markup trim, never throws.
  //   jogHold, nudgeHold -- already-constructed hold loops (jog-hold.js /
  //     nudge-hold.js). Cockpit only ever calls .start()/.stop()/.active on
  //     these -- app.js owns their post/gate/onFailure wiring, exactly as it
  //     owns CameraPanel's WHEP session factory.
  //   post -- async (path, body) => data|null; the same postControl
  //     contract used everywhere else in app.js. Wired to the aircraft
  //     list's [Track] button.
  constructor({ el, jogHold, nudgeHold, post }) {
    this.el = el || {};
    this.jogHold = jogHold;
    this.nudgeHold = nudgeHold;
    this.post = post;

    // Last mode computed by render() -- "jog" | "trim" | "locked". Public:
    // app.js's keyboard/joystick wiring reads this instead of keeping its
    // own second copy of "am I tracking" (see ui-mode.js's module doc on
    // why a local flag is exactly what must not exist).
    this.mode = "jog";

    // Only one direction can be held at a time (mirrors the old one-button-
    // at-a-time click model) -- the JOG_SOURCES key that currently owns the
    // active hold, so a stray release from a control that never started the
    // hold is a no-op instead of cutting off someone else's press.
    this._activeHoldSource = null;

    for (const sourceId of Object.keys(DIRECTIONS)) this._wireButton(sourceId);
  }

  // Called once per SSE tick with the full dashboard state.
  render(state) {
    const s = state || {};
    this._renderMode(s.mode);
    this._renderServices(s.services);
    this._renderRig(s.rig);
    this._renderTracking(s.tracking);
    this._renderAdsb(s.adsb);
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
      el.trkLimits.textContent = badges.length ? badges.join(", ") : "none";
      el.trkLimits.className = badges.length ? "bad" : "ok";
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

  _renderAdsb(adsb) {
    const el = this.el;
    if (!el.adsbList) return;
    const a = adsb ?? { rawCount: null, trackable: [] };
    const trackable = Array.isArray(a.trackable) ? a.trackable : [];
    if (el.adsbCount) {
      el.adsbCount.textContent = a.rawCount === null || a.rawCount === undefined
        ? `(${trackable.length} trackable)`
        : `(${trackable.length} trackable / ${a.rawCount} seen)`;
    }

    if (trackable.length === 0) {
      el.adsbList.innerHTML = '<div class="list-empty">no trackable aircraft</div>';
      return;
    }

    el.adsbList.innerHTML = trackable.map((row) => {
      const label = escapeHtml(row.callsign || row.hex);
      const alt = row.altitude_m === null || row.altitude_m === undefined ? "—" : `${Math.round(row.altitude_m)} m`;
      const gs = row.ground_speed_kt === null || row.ground_speed_kt === undefined ? "—" : `${Math.round(row.ground_speed_kt)} kt`;
      return `
        <div class="adsb-row" data-hex="${escapeHtml(row.hex)}">
          <div class="adsb-main">
            <span class="adsb-label" title="alt ${alt}, gs ${gs}, cat ${escapeHtml(row.category ?? "—")}, sqk ${escapeHtml(row.squawk ?? "—")}">${label}</span>
            <button type="button" class="track-btn" data-hex="${escapeHtml(row.hex)}">Track</button>
          </div>
          <div class="adsb-meta">
            az ${fmt(row.azimuth_deg, 0)}° / el ${fmt(row.elevation_deg, 0)}°
            &middot; ${fmt(row.range_km, 1)} km
            &middot; ${Math.round(row.est_track_sec)}s
          </div>
        </div>`;
    }).join("");

    for (const btn of el.adsbList.querySelectorAll("button.track-btn")) {
      btn.addEventListener("click", () => {
        this.post("track", { hex: btn.dataset.hex });
      });
    }
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

    const svcStates = Object.values(services);
    const svcCls = svcStates.length === 0
      ? "led-unknown"
      : svcStates.some((v) => v === "failed")
        ? "led-failed"
        : svcStates.every((v) => v === "active")
          ? "led-active"
          : "led-unknown";

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

  // -- AIM block ----------------------------------------------------------
  //
  // The label and the four direction buttons' behaviour both come from
  // aimMode(state) -- never re-derived from a local flag. "locked" always
  // wins over "trim" (aimMode checks E-STOP/sun-lock before tracking state;
  // see ui-mode.js) -- this method must not reorder that itself either, it
  // simply renders whatever aimMode already decided.
  _renderAim(state) {
    const mode = aimMode(state);
    this.mode = mode;
    const el = this.el;
    const buttons = [el.jogUp, el.jogDown, el.jogLeft, el.jogRight].filter(Boolean);

    if (mode === "locked") {
      const reason = this._lockReason(state);
      if (el.jogMode) {
        el.jogMode.textContent = `LOCKED — ${reason}`;
        el.jogMode.classList.remove("jog-mode-label-trim");
        el.jogMode.classList.add("bad");
      }
      if (el.jog) el.jog.classList.remove("jog-mode-trim");
      for (const b of buttons) b.disabled = true;
      this._haltHoldUnconditionally();
      return;
    }

    for (const b of buttons) b.disabled = false;

    if (mode === "trim") {
      const t = state.tracking || {};
      const panOff = typeof t.offsetPanDeg === "number" ? t.offsetPanDeg : 0;
      const tiltOff = typeof t.offsetTiltDeg === "number" ? t.offsetTiltDeg : 0;
      if (el.jogMode) {
        el.jogMode.textContent = `TRIM ${fmtPair(panOff, tiltOff, "°", 2)}`;
        el.jogMode.classList.add("jog-mode-label-trim");
        el.jogMode.classList.remove("bad");
      }
      if (el.jog) el.jog.classList.add("jog-mode-trim");
    } else {
      if (el.jogMode) {
        el.jogMode.textContent = "JOG";
        el.jogMode.classList.remove("jog-mode-label-trim", "bad");
      }
      if (el.jog) el.jog.classList.remove("jog-mode-trim");
    }
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

  _activeHold() {
    return this.mode === "trim" ? this.nudgeHold : this.jogHold;
  }

  // Stops whatever is currently held, regardless of which control started
  // it, and regardless of which hold class is "current" -- both jogHold and
  // nudgeHold are stopped unconditionally (each stop() is a no-op on the
  // class that was never active), matching the old app.js's
  // stopHoldUnconditionally()/mid-lock behaviour exactly.
  _haltHoldUnconditionally() {
    if (this._activeHoldSource === null) return;
    this._releaseHoldSlot();
    this.jogHold.stop();
    this.nudgeHold.stop();
  }

  _releaseHoldSlot() {
    if (this._activeHoldSource === null) return;
    const btn = this.el[DIRECTIONS[this._activeHoldSource].elKey];
    if (btn) btn.classList.remove("jog-holding");
    this._activeHoldSource = null;
  }

  // Called by _wireButton's pointer handlers below, AND by app.js's
  // keyboard listener (arrow keys drive the same four directions) -- public
  // on purpose, so app.js's document-level keydown wiring has one place to
  // delegate to instead of re-implementing the gate/slot logic.
  startHold(sourceId) {
    if (this.mode === "locked") return; // defense in depth -- a keyboard
    // press has no [disabled] to stop it the way a button click does.
    if (this._activeHoldSource !== null) return; // another direction is already held
    const { panMul, tiltMul, elKey } = DIRECTIONS[sourceId];
    const hold = this._activeHold();
    hold.start(panMul, tiltMul);
    if (!hold.active) return; // refused: gated (E-STOP / sun-lock) at the hold's own level
    this._activeHoldSource = sourceId;
    const btn = this.el[elKey];
    if (btn) btn.classList.add("jog-holding");
  }

  // Only stops the hold if `sourceId` is the one that started it. Stops
  // BOTH hold classes unconditionally (the mode can flip mid-press -- a
  // track lock landing while a jog is held, or stop_tracking landing while
  // a nudge is held) -- each stop() is a no-op on the class that was never
  // active anyway.
  stopHold(sourceId) {
    if (this._activeHoldSource !== sourceId) return;
    this._releaseHoldSlot();
    this.jogHold.stop();
    this.nudgeHold.stop();
  }

  // For the "a press can end without telling the control that started it"
  // triggers (window blur, tab hidden) -- app.js wires these to window/
  // document events and delegates here.
  stopHoldUnconditionally() {
    this._haltHoldUnconditionally();
  }

  _wireButton(sourceId) {
    const btn = this.el[DIRECTIONS[sourceId].elKey];
    if (!btn) return;

    btn.addEventListener("pointerdown", (evt) => {
      if (btn.disabled) return; // defense in depth; a disabled button shouldn't fire this at all
      evt.preventDefault();
      if (btn.setPointerCapture) btn.setPointerCapture(evt.pointerId); // a drag off the button still delivers pointerup here
      this.startHold(sourceId);
    });

    // pointerup: the normal release. pointerleave: the pointer physically
    // left the button (still fires under capture). pointercancel: the
    // gesture was interrupted. All three must stop the rig; none is
    // optional.
    const endPress = (evt) => {
      if (btn.hasPointerCapture && btn.hasPointerCapture(evt.pointerId)) {
        btn.releasePointerCapture(evt.pointerId);
      }
      this.stopHold(sourceId);
    };
    btn.addEventListener("pointerup", endPress);
    btn.addEventListener("pointerleave", endPress);
    btn.addEventListener("pointercancel", endPress);
  }
}
