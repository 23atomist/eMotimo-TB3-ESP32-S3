export interface ControlDeps {
  track(hex: string): Promise<void>;
  stopTracking(): Promise<void>;
  jog(panDps: number, tiltDps: number, durationMs: number): Promise<void>;
  // Drift-calibration aim-offset (see track/offset.ts + nudge_aim_offset):
  // applied to the TRACKING SETPOINT, never a raw jog — the dashboard's
  // direction buttons route here instead of jog() while tracking is active.
  nudgeAimOffset(deltaPanDeg: number, deltaTiltDeg: number): Promise<void>;
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
        await d.nudgeAimOffset(num(body.delta_pan_deg), num(body.delta_tilt_deg));
        return { ok: true, message: "aim offset nudged" };
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
