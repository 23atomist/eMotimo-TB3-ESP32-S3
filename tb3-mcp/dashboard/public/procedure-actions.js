// The Setup drawer's guided-procedure ACTIONS: the impure glue between
// procedures.js's pure renderers (calibration, travel limits, set home) and
// the daemon (postControl) / the browser (window.prompt/window.confirm).
// procedures.js renders step-gate.js's ordered steps and hands a clicked
// step's id back to stepHandler, which dispatches into the actions built
// here -- this module is the only place that actually talks to the daemon
// or the browser on the procedure's behalf, so procedures.js itself stays
// presentation-only and DOM-free (see its own module doc).
//
// Split out of app.js (2026-07-28 dashboard redesign, task 10) purely to
// keep that file under this project's 800-line ceiling -- no behaviour
// change from what app.js's own "guided calibration/travel-limits/set-home
// procedure" sections already did. app.js's mutable latches (estopLatched,
// sunLocked, lastState) are threaded through as accessor functions rather
// than closed-over module vars, since they now live in a different file.
import {
  renderCalibration, stepHandler, sightingStripHtml, formatTrackedAircraft, formatTrimOffset,
  renderTravelLimits, teachStripHtml, formatCurrentPanTilt, renderSetHome, destructiveConfirm,
} from "./procedures.js";

// deps:
//   drawer         -- the Drawer instance (Task 7), or null if the page has
//                      no drawer.
//   drawerBody     -- #drawer-body, for the single delegated data-act
//                      listener (see the VERB_HANDLERS map below).
//   postControl    -- async (path, body) => data|null (see app.js's own doc).
//   toast          -- (message, ok) => void.
//   getLastState   -- () => the most recent SSE tick (app.js's `lastState`).
//   isEstopLatched, isSunLocked -- () => boolean (app.js's own local latches).
//   isTrimActive   -- () => boolean (aimMode-derived; see app.js).
// Returns { sightTrackedAircraft, refreshSetupDrawer } -- the two entry
// points app.js's own render()/joystick wiring still need directly (sighting
// is shared with the physical joystick's Sight button; refreshSetupDrawer is
// called once per SSE tick from app.js's render()).
export function initProcedureActions({
  drawer, drawerBody, postControl, toast, getLastState, isEstopLatched, isSunLocked, isTrimActive,
}) {
  // Every calibration write below except sighting (set-location/
  // characterize-imu/set-north-zero/solve) checks the sun guard server-side
  // (geo-tools.ts/imu-tools.ts) and refuses under a lock -- checked here too
  // so the operator gets an immediate reason instead of waiting on a round
  // trip that was always going to fail. `commandsMotion` is true only for
  // characterize_imu's sweep ("Motion tool — respects limits, sun guard,
  // deadman", imu-tools.ts) -- every other write covered by this function is
  // a stored coordinate or a stationary reading, harmless under E-STOP on
  // the ACTUATION axis, and gated on the sun lock alone. sight_aircraft is
  // deliberately NOT covered here -- see sightGateOk below for why it needs
  // a stricter, separate gate (review fix, UI-8 fix round, finding I-3).
  function calibrationGateOk(commandsMotion) {
    if (commandsMotion && isEstopLatched()) {
      toast("E-STOP latched — cannot run the IMU sweep", false);
      return false;
    }
    if (isSunLocked()) {
      toast("sun guard locked — calibration writes are refused while parked", false);
      return false;
    }
    return true;
  }

  // sight_aircraft/sight_landmark command no motion either (same actuation-
  // axis argument as calibrationGateOk's non-motion writes), but sighting has
  // a DATA-VALIDITY axis calibrationGateOk's other writes don't: it records
  // an aircraft's (or landmark's) position against whatever pan/tilt the rig
  // happens to be holding RIGHT NOW. E-STOP halts a tracking slew wherever it
  // lands, so the instant it latches the rig is -- by definition -- no longer
  // centred on the target; sighting at that moment would pair the target's
  // position with a pan/tilt the rig isn't actually holding on it, writing a
  // wrong pair into the calibration profile. So, unlike calibrationGateOk's
  // other writes, this refuses under E-STOP too, unioned with the same
  // sun-lock check every other calibration write already has.
  function sightGateOk() {
    if (isEstopLatched()) {
      toast("E-STOP latched — sighting refused (the rig may no longer be centred on the target)", false);
      return false;
    }
    if (isSunLocked()) {
      toast("sun guard locked — calibration writes are refused while parked", false);
      return false;
    }
    return true;
  }

  // teach_limit captures the rig's CURRENT position as a mechanical travel
  // limit -- the same DATA-VALIDITY axis as sightGateOk above, not
  // calibrationGateOk's non-motion convention. E-STOP can halt a jog before
  // it reaches the edge the operator was heading for, so the rig may no
  // longer BE at that edge the instant it latches. A sun lock is worse than
  // merely inhibiting the capture: sunLocked === true means the sun guard
  // has already FLOWN the rig to its park position
  // (SunSupervisor.driveParkTick, src/track/supervisor.ts) -- capturing then
  // would teach the PARK position as a mechanical travel limit, not
  // wherever the operator jogged to, and a resulting tilt edge tighter than
  // parkTiltDeg can even grind the sun guard's own escape move into a hard
  // stop (supervisor.ts's own comment on this exact hazard). clear_taught_limits
  // is a pure revert, already confirm-gated (destructiveConfirm), and stays
  // ungated here.
  function teachGateOk() {
    if (isEstopLatched()) {
      toast("E-STOP latched — teaching a limit is refused (the rig may no longer be at this edge)", false);
      return false;
    }
    if (isSunLocked()) {
      toast(
        "sun guard locked — the rig has been parked; teaching a limit now would record the park position, not the edge",
        false,
      );
      return false;
    }
    return true;
  }

  // Rig location has no persistent input form in the guided procedure -- a
  // single combined prompt. IMPORTANT: set_rig_location REPLACES THE WHOLE
  // CALIBRATION PROFILE (src/calibration.ts's setRigLocation: `{ version: 1,
  // rig, sightings: [] }`) -- it is not an in-place coordinate edit.
  // Re-running it after characterize_imu has already solved a mounting
  // throws away that IMU sweep, the orientation, and every sighting, not
  // just the coordinate. The prompt names this consequence once there's
  // something real to lose, and procedures.js renders step 1's already-done
  // link as [reset] rather than [redo] for the same reason.
  function editRigLocation() {
    if (!calibrationGateOk(false)) return;
    const cal = (getLastState() && getLastState().calibration) || {};
    const rig = cal.rig;
    const hasImu = !!cal.imuMounting;
    const current = rig ? `${rig.lat}, ${rig.lon}, ${rig.height}` : "";
    const warning = hasImu
      ? "WARNING: this RESETS the whole calibration profile -- the IMU sweep, " +
        "orientation, and every sighting are all discarded, not just the coordinate.\n\n"
      : "";
    const raw = window.prompt(`${warning}Rig location — lat, lon, height_m:`, current);
    if (raw === null) return; // cancelled
    const parts = raw.split(",").map((p) => parseFloat(p.trim()));
    if (parts.length !== 3 || !parts.every(Number.isFinite)) {
      toast("rig location needs lat, lon, height_m as three numbers", false);
      return;
    }
    const [lat, lon, height] = parts;
    postControl("calibrate/set-location", { lat, lon, height_m: height });
  }

  // Records a sighting for whatever aircraft is CURRENTLY tracked
  // (state.tracking.hex) -- the guided procedure's whole flow is track a
  // plane -> trim to centre -> sight, so there is no separate aircraft picker
  // here. Shared by the sighting strip's [Sight it] button below AND the
  // physical joystick's Sight button (see app.js's JoystickHold wiring) --
  // one implementation, not two parallel ones for the same action.
  async function sightTrackedAircraft() {
    const state = getLastState();
    const hex = state && state.tracking && state.tracking.hex;
    if (!hex) { toast("no aircraft currently tracked — track one first", false); return null; }
    if (!sightGateOk()) return null;
    return postControl("calibrate/sight-aircraft", { hex });
  }

  // The landmark path (sight_landmark) remains available as an alternative
  // to sighting a tracked aircraft on sight-1/sight-2 (design doc). It
  // commands no motion (aim via jog, then record the CURRENT pointing
  // against a known lat/lon/height), so it shares sightTrackedAircraft's
  // stricter gate, not calibrationGateOk's. `stepId` picks the sighting
  // slot's label (A for sight-1, B for sight-2).
  async function sightLandmarkForStep(stepId) {
    if (!sightGateOk()) return null;
    const raw = window.prompt(
      "Landmark sighting — lat, lon, height_m (aim the rig at the landmark first, then confirm):", "",
    );
    if (raw === null) return null; // cancelled
    const parts = raw.split(",").map((p) => parseFloat(p.trim()));
    if (parts.length !== 3 || !parts.every(Number.isFinite)) {
      toast("landmark sighting needs lat, lon, height_m as three numbers", false);
      return null;
    }
    const [lat, lon, height] = parts;
    const label = stepId === "sight-2" ? "B" : "A";
    return postControl("calibrate/sight", { lat, lon, height_m: height, label });
  }

  // A sighting step (sight-1/sight-2) hands off to the drawer's strip -- a
  // plane crosses a zoomed field of view in ~2s by hand, but once the rig is
  // TRACKING it slews with the plane and goes nearly stationary in frame,
  // giving the operator the whole pass to trim (see drawer.js's module doc).
  // [Sight it] re-expands the drawer on success so the step reads done;
  // [cancel] does the same without sighting anything.
  let sightingInFlight = false;
  function startSighting(stepId, drawerRef) {
    sightingInFlight = false;
    drawerRef.collapseToStrip(sightingStripHtml(stepId, getLastState()), {
      "strip-sight": async () => {
        if (sightingInFlight) return; // one in-flight sight at a time
        sightingInFlight = true;
        try {
          const data = await sightTrackedAircraft();
          if (data && data.ok) drawerRef.expand();
        } finally {
          sightingInFlight = false;
        }
      },
      "strip-cancel": () => drawerRef.expand(),
    });
  }

  const calibrationActions = {
    editRigLocation,
    runImu: () => { if (calibrationGateOk(true)) postControl("calibrate/characterize-imu", {}); },
    setNorthZero: () => { if (calibrationGateOk(false)) postControl("calibrate/set-north-zero", {}); },
    solve: () => { if (calibrationGateOk(false)) postControl("calibrate/solve", {}); },
    startSighting,
    sightLandmark: sightLandmarkForStep,
  };

  if (drawer) {
    // Registered once; called fresh on every render (drawer.js's own doc on
    // setEntryRenderer) so the step list always reflects the latest tick's
    // state, never whatever it was when the drawer was first opened.
    drawer.setEntryRenderer("calibration", () => renderCalibration(getLastState(), calibrationActions));
  }

  // teach_limit/get_taught_limits/clear_taught_limits (src/limits-tools.ts)
  // are motion-free-of-the-ACTUATION-axis -- capturing an edge itself
  // commands no motion. But client-side, capturing the CURRENT position is
  // exactly sightGateOk's DATA-VALIDITY concern (see teachGateOk above), not
  // calibrationGateOk's -- gated via teachGateOk, checked both here (defense
  // in depth for a latch tripping mid-strip) and structurally in
  // procedures.js's limitsRow (no [Teach] control at all when already
  // gated).
  //
  // Same open<->strip handoff as calibration's sighting steps: teaching an
  // edge is an AIMING action, so [Teach] collapses the drawer to a strip and
  // leaves the full cockpit -- jog controls, video, E-STOP -- live
  // underneath (see drawer.js's module doc).
  let teachCaptureInFlight = false; // one in-flight capture at a time
  function startTeach(edge, drawerRef) {
    teachCaptureInFlight = false;
    drawerRef.collapseToStrip(teachStripHtml(edge, getLastState()), {
      "strip-capture": async () => {
        if (teachCaptureInFlight) return;
        if (!teachGateOk()) return;
        teachCaptureInFlight = true;
        try {
          const data = await postControl("limits/teach", { edge });
          if (data && data.ok) drawerRef.expand();
        } finally {
          teachCaptureInFlight = false;
        }
      },
      "strip-cancel": () => drawerRef.expand(),
    });
  }

  const travelLimitsActions = {
    startTeach,
    // Gated by destructiveConfirm (procedures.js) -- reverting to the wider
    // config ceiling is a real loss of every field-taught edge, even though
    // it's far cheaper to redo than a full calibration. Deliberately NOT
    // also gated by teachGateOk -- it's a pure revert, not a capture, and
    // the confirmation is the safety this action needs.
    clearLimits: () => {
      if (!confirmDestructive("clear_taught_limits")) return;
      postControl("limits/clear-taught", {});
    },
  };

  if (drawer) {
    // estopLatched/sunLocked folded in (not part of the raw SSE payload) so
    // renderTravelLimits/limitsRow can gate each [Teach] control
    // structurally -- same convention cockpit.render()'s own
    // `{...state, estopLatched, sunLocked}` uses for the AIM block's locked
    // mode (ui-mode.js's aimMode).
    drawer.setEntryRenderer("travel-limits", () => renderTravelLimits(
      { ...getLastState(), estopLatched: isEstopLatched(), sunLocked: isSunLocked() },
      travelLimitsActions,
    ));
  }

  // set_home (src/tools.ts) silently clears BOTH the calibration and the
  // taught travel limits (they were measured relative to the OLD zero).
  // confirmDestructive wraps destructiveConfirm (procedures.js, pure) with
  // the one browser-side effect it deliberately doesn't own itself:
  // actually showing the confirmation.
  function confirmDestructive(action) {
    const { needed, message } = destructiveConfirm(action, getLastState());
    if (!needed) return true;
    return window.confirm(message);
  }

  const setHomeActions = {
    // set_home also refuses server-side under a sun lock AND while tracking
    // is active (src/tools.ts: "tracking active; stop_tracking first") --
    // both checked here too, for an immediate reason instead of a doomed
    // round trip AND before ever showing the destructive confirmation.
    setHome: () => {
      if (isSunLocked()) { toast("sun guard locked — set home is refused while parked", false); return; }
      if (isTrimActive()) { toast("tracking active — stop tracking before setting home", false); return; }
      if (!confirmDestructive("set_home")) return;
      postControl("home/set", {});
    },
  };

  if (drawer) {
    // sunLocked folded in (see the travel-limits registration above for the
    // same convention) so renderSetHome can gate [Set home] structurally --
    // no control at all, a visible reason instead, when the daemon would
    // refuse it anyway.
    drawer.setEntryRenderer("set-home", () => renderSetHome({ ...getLastState(), sunLocked: isSunLocked() }, setHomeActions));
  }

  // Delegated (not per-button) click handling for every drawer body's action
  // controls -- calibration's [run]/[redo]/[reset]/[start]/[use a landmark
  // instead], travel-limits' [Teach <edge>]/[clear taught limits], and Set
  // home's [Set home]. drawer.js only rewrites #drawer-body's innerHTML when
  // its content actually changes, but a rewrite can still happen at any time
  // and would silently drop a listener attached directly to one of those
  // buttons -- a single listener on the stable #drawer-body container
  // survives every rewrite instead.
  //
  // A verb -> handler map (rather than an if-chain) now that this dispatch
  // has its own module: every non-step verb below is a direct lookup;
  // anything else (run/redo/reset/start, keyed on a step-gate.js step id, not
  // one of these verbs) falls through to stepHandler exactly as before.
  const VERB_HANDLERS = {
    landmark: (id) => calibrationActions.sightLandmark(id),
    teach: (id, drawerRef) => travelLimitsActions.startTeach(id, drawerRef),
    "clear-limits": () => travelLimitsActions.clearLimits(),
    home: (id) => { if (id === "set") setHomeActions.setHome(); },
  };

  if (drawerBody) {
    drawerBody.addEventListener("click", (evt) => {
      const btn = evt.target.closest("[data-act]");
      if (!btn || !drawer) return;
      const [verb, id] = btn.dataset.act.split(":");
      const handler = VERB_HANDLERS[verb];
      if (handler) { handler(id, drawer); return; }
      stepHandler(id, drawer, getLastState(), calibrationActions);
    });
  }

  // Refreshes whichever Setup-drawer entry is open (calibration, travel
  // limits, or set home -- drawer.refresh() re-renders whatever's currently
  // active, not just calibration) or the currently-collapsed strip's live
  // readouts, once per SSE tick. updateStrip() silently skips any named
  // region absent from whichever strip is currently showing, so pushing all
  // three regions unconditionally is safe whether the sighting strip or the
  // teach-limit strip is the one actually up.
  function refreshSetupDrawer(state) {
    if (!drawer) return;
    const mode = drawer.mode();
    if (mode === "open") drawer.refresh();
    else if (mode === "strip") {
      drawer.updateStrip({
        aircraft: formatTrackedAircraft(state),
        offset: formatTrimOffset(state),
        pantilt: formatCurrentPanTilt(state),
      });
    }
  }

  return { sightTrackedAircraft, refreshSetupDrawer };
}
