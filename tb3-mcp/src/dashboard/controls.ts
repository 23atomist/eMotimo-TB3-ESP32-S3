export interface ControlDeps {
  track(hex: string): Promise<void>;
  stopTracking(): Promise<void>;
  jog(panDps: number, tiltDps: number, durationMs: number): Promise<void>;
  // Drift-calibration aim-offset (see track/offset.ts + nudge_aim_offset):
  // applied to the TRACKING SETPOINT, never a raw jog — the dashboard's
  // direction buttons route here instead of jog() while tracking is active.
  nudgeAimOffset(deltaPanDeg: number, deltaTiltDeg: number): Promise<string>;
  setRigLocation(lat: number, lon: number, heightM: number): Promise<void>;
  sightLandmark(lat: number, lon: number, heightM: number, label?: string): Promise<void>;
  // Aircraft-based calibration sighting (see src/adsb/extrapolate.js +
  // src/geo-tools.js's sight_aircraft): returns the raw tool response text
  // (slot filled, extrapolation applied, any separation warning), same
  // convention as solveCalibration below -- the caller just relays it.
  sightAircraft(hex: string): Promise<string>;
  solveCalibration(): Promise<string>;
  clearCalibration(): Promise<void>;
  getTrackSector(): Promise<{ enabled: boolean; startDeg: number; endDeg: number }>;
  setTrackSector(startDeg: number, endDeg: number, enabled: boolean): Promise<void>;
  setSunGuard(enabled: boolean): Promise<void>;
  firmwareStop(): Promise<void>;
  agentStop(): Promise<void>;
  agentStart(): Promise<void>;
  // Camera arm/disarm — synchronous (they just flip the in-process
  // CameraStreamer's state); no rig motion, so no daemon round-trip.
  cameraStart(): void;
  cameraStop(): void;
  // The tools below (characterize_imu, set_north_zero, teach_limit,
  // clear_taught_limits, set_home, capture_snapshot, start_recording,
  // stop_recording) had no dashboard transport at all before this -- each
  // just relays the daemon's own response text, same convention as
  // sightAircraft/solveCalibration above.
  characterizeImu(): Promise<string>;
  setNorthZero(): Promise<string>;
  teachLimit(edge: string): Promise<string>;
  clearTaughtLimits(): Promise<string>;
  // Destructive (clears the calibration AND the taught travel limits) --
  // deliberately no special-cased confirmation here: that's a UI concern for
  // a later task, not this transport.
  setHome(): Promise<string>;
  captureSnapshot(icao?: string): Promise<string>;
  startRecording(): Promise<string>;
  stopRecording(): Promise<string>;
  // set_capture_mode (src/tools.ts) -- the only thing that flips
  // captureAutoEnabled, which the dashboard could previously display but
  // never change (review fix, finding I-3). The chip no longer contradicts
  // the [Record] button either: capture-label.js now reads `recording`
  // ahead of `autoEnabled`, so an auto-off host that IS recording says so.
  setCaptureMode(enabled: boolean): Promise<string>;
}

export interface ActionResult { ok: boolean; message: string; }
export interface EstopResult { firmware: ActionResult; tracking: ActionResult; agent: ActionResult; allOk: boolean; }

function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

async function attempt(fn: () => Promise<unknown>, okMsg: string): Promise<ActionResult> {
  try { await fn(); return { ok: true, message: okMsg }; }
  catch (e) { return { ok: false, message: msg(e) }; }
}

export async function emergencyStop(d: ControlDeps): Promise<EstopResult> {
  const [firmware, tracking, agent] = await Promise.all([
    attempt(() => d.firmwareStop(), "rig stopped"),
    attempt(() => d.stopTracking(), "tracking stopped"),
    attempt(() => d.agentStop(), "agent stopped"),
  ]);
  return { firmware, tracking, agent, allOk: firmware.ok && tracking.ok && agent.ok };
}

function num(v: unknown, dflt = 0): number { return typeof v === "number" && Number.isFinite(v) ? v : dflt; }
function str(v: unknown): string | undefined { return typeof v === "string" ? v : undefined; }

export async function runAction(d: ControlDeps, action: string, body: Record<string, unknown>): Promise<ActionResult> {
  try {
    switch (action) {
      case "track": {
        const hex = str(body.hex);
        if (!hex) return { ok: false, message: "hex required" };
        await d.track(hex); return { ok: true, message: `tracking ${hex}` };
      }
      case "stop": await d.stopTracking(); return { ok: true, message: "tracking stopped" };
      case "agent":
        if (body.on === true) { await d.agentStart(); return { ok: true, message: "agent started" }; }
        await d.agentStop(); return { ok: true, message: "agent stopped" };
      case "jog":
        await d.jog(num(body.pan_dps), num(body.tilt_dps), num(body.duration_ms, 300));
        return { ok: true, message: "jogged" };
      case "nudge-aim-offset":
        // Pass the tool's JSON straight through -- it carries `clamped`, and
        // a swallowed clamp is a control that silently stops working.
        return { ok: true, message: await d.nudgeAimOffset(num(body.delta_pan_deg), num(body.delta_tilt_deg)) };
      case "calibrate/set-location":
        await d.setRigLocation(num(body.lat), num(body.lon), num(body.height_m));
        return { ok: true, message: "rig location set" };
      case "calibrate/sight":
        await d.sightLandmark(num(body.lat), num(body.lon), num(body.height_m), str(body.label));
        return { ok: true, message: "landmark sighted" };
      case "calibrate/sight-aircraft": {
        const hex = str(body.hex);
        if (!hex) return { ok: false, message: "hex required" };
        return { ok: true, message: await d.sightAircraft(hex) };
      }
      case "calibrate/solve": return { ok: true, message: await d.solveCalibration() };
      case "calibrate/clear": await d.clearCalibration(); return { ok: true, message: "calibration cleared" };
      case "calibrate/characterize-imu": return { ok: true, message: await d.characterizeImu() };
      case "calibrate/set-north-zero": return { ok: true, message: await d.setNorthZero() };
      case "limits/teach": {
        const edge = str(body.edge);
        if (!edge) return { ok: false, message: "edge required" };
        return { ok: true, message: await d.teachLimit(edge) };
      }
      case "limits/clear-taught": return { ok: true, message: await d.clearTaughtLimits() };
      // No special confirmation here -- set_home is destructive (clears the
      // calibration and the taught travel limits) but that confirmation is a
      // UI concern belonging to a later task, not this transport.
      case "home/set": return { ok: true, message: await d.setHome() };
      case "capture/snapshot": return { ok: true, message: await d.captureSnapshot(str(body.icao)) };
      case "capture/start-recording": return { ok: true, message: await d.startRecording() };
      case "capture/stop-recording": return { ok: true, message: await d.stopRecording() };
      case "capture/set-mode": return { ok: true, message: await d.setCaptureMode(body.enabled === true) };
      case "sector/set":
        await d.setTrackSector(num(body.start_deg), num(body.end_deg), body.enabled === true);
        return { ok: true, message: "tracking sector set" };
      case "sun-guard/set":
        await d.setSunGuard(body.enabled === true);
        return { ok: true, message: `sun guard ${body.enabled === true ? "enabled" : "disabled"}` };
      case "camera/start": d.cameraStart(); return { ok: true, message: "camera on" };
      case "camera/stop": d.cameraStop(); return { ok: true, message: "camera off" };
      default: return { ok: false, message: `unknown action: ${action}` };
    }
  } catch (e) { return { ok: false, message: msg(e) }; }
}
