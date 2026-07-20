export interface RigImu {
  ok: boolean;
  pitchDeg: number | null; rollDeg: number | null;
  tempC: number | null; pressHpa: number | null;
}
export interface RigDirect {
  connected: boolean;
  moving: boolean;
  batteryV: number | null;
  panSteps: number | null;
  tiltSteps: number | null;
  imu: RigImu | null;
  joyLatched: boolean;
}
export type ServiceState = "active" | "inactive" | "failed" | "unknown";

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function parseRigStatus(raw: unknown): RigDirect {
  const empty: RigDirect = {
    connected: false, moving: false, batteryV: null,
    panSteps: null, tiltSteps: null, imu: null, joyLatched: false,
  };
  if (typeof raw !== "object" || raw === null) return empty;
  const r = raw as Record<string, unknown>;
  const pos = (typeof r.pos === "object" && r.pos !== null) ? r.pos as Record<string, unknown> : null;
  if (!pos) return empty;   // no position block → not a real /api/status body

  let imu: RigImu | null = null;
  if (typeof r.imu === "object" && r.imu !== null) {
    const i = r.imu as Record<string, unknown>;
    imu = {
      ok: i.ok === true || i.ok === 1,
      pitchDeg: numOrNull(i.pitch), rollDeg: numOrNull(i.roll),
      tempC: numOrNull(i.tempC), pressHpa: numOrNull(i.pressHpa),
    };
  }
  return {
    connected: true,
    moving: r.moving === true || r.moving === 1,
    batteryV: numOrNull(r.battery_v),
    panSteps: numOrNull(pos.pan),
    tiltSteps: numOrNull(pos.tilt),
    imu,
    joyLatched: r.joy_latched === true,
  };
}

export function parseServiceState(out: string): ServiceState {
  const s = out.trim();
  if (s === "active") return "active";
  if (s === "inactive" || s === "activating" || s === "deactivating") return "inactive";
  if (s === "failed") return "failed";
  return "unknown";
}
