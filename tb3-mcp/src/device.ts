import WebSocket from "ws";
import { Config } from "./config.js";
import { DeviceState } from "./types.js";
import { STEPS_PER_DEG } from "./angles.js";

const ARRIVAL_TOL_STEPS = 0.25 * STEPS_PER_DEG;
const COMMAND_TIMEOUT_MS = 2000;
const JOG_KEEPALIVE_MS = 100;

/**
 * A non-OK HTTP response from the device, carrying the status code alongside
 * the firmware's error text. Callers that must react differently per cause
 * (409 "the rig is still moving" is routine and self-healing; a timeout is
 * not) need the code, and matching on the message string would couple them to
 * firmware wording. Thrown with the message the firmware sent, so existing
 * message-formatting call sites are unaffected.
 */
export class DeviceHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "DeviceHttpError";
  }
}

export class Device {
  private cfg: Config;
  private hosts: string[];
  private hostIdx = 0;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private state: DeviceState = {
    connected: false, panSteps: 0, tiltSteps: 0, auxSteps: 0,
    moving: false, programEngaged: false, batteryV: 0, staIp: "", lastUpdateMs: 0,
  };
  private jogVec: { x: number; y: number; aux: number; expiresAtMs: number } | null = null;
  private jogTimer: NodeJS.Timeout | null = null;
  private jogLocked = false;

  constructor(cfg: Config, private readonly now: () => number = Date.now) {
    this.cfg = cfg;
    this.hosts = [cfg.deviceHost, ...(cfg.deviceIpFallback ? [cfg.deviceIpFallback] : [])];
  }

  private httpBase(): string { return `http://${this.hosts[this.hostIdx]}`; }
  private wsUrl(): string { return `ws://${this.hosts[this.hostIdx]}/ws`; }

  start(): void {
    this.closed = false;
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopJogTimer();
    this.jogVec = null;
    this.ws?.removeAllListeners();
    this.ws?.close();
    this.ws = null;
    this.state.connected = false;
  }

  getState(): DeviceState { return { ...this.state }; }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.wsUrl());
    this.ws = ws;
    ws.on("open", () => { this.state.connected = true; });
    ws.on("message", (buf) => this.onTick(buf.toString()));
    ws.on("close", () => { this.state.connected = false; this.scheduleReconnect(); });
    ws.on("error", () => { /* close will follow */ });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.hosts.length > 1) this.hostIdx = (this.hostIdx + 1) % this.hosts.length;
      this.connect();
    }, 1000);
  }

  private onTick(raw: string): void {
    try {
      const d = JSON.parse(raw);
      if (d.type !== "tick" || !Array.isArray(d.pos)) return;
      this.state.panSteps = d.pos[0];
      this.state.tiltSteps = d.pos[1];
      this.state.auxSteps = d.pos[2];
      this.state.moving = d.moving !== 0;
      this.state.programEngaged = d.prog === 1;
      this.state.batteryV = d.batt ?? this.state.batteryV;
      this.state.staIp = d.sta ?? this.state.staIp;
      this.state.lastUpdateMs = this.now();
      if (d.imu && typeof d.imu === "object") {
        this.state.imu = {
          ok: d.imu.ok === true || d.imu.ok === 1,
          pitchDeg: Number(d.imu.pitch),
          rollDeg: Number(d.imu.roll),
          tempC: Number(d.imu.tempC),
          pressHpa: Number(d.imu.pressHpa),
        };
      }
    } catch { /* ignore malformed tick */ }
  }

  private async post(path: string, body?: object): Promise<Response> {
    return fetch(`${this.httpBase()}${path}`, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
    });
  }

  private async errText(r: Response): Promise<string> {
    try { const j = await r.json(); return (j as any).error ?? `HTTP ${r.status}`; }
    catch { return `HTTP ${r.status}`; }
  }

  async gotoAngle(devicePanDeg: number, deviceTiltDeg: number, speedDps?: number): Promise<void> {
    const r = await this.post("/api/goto", {
      pan_deg: devicePanDeg, tilt_deg: deviceTiltDeg, speed_dps: speedDps,
    });
    if (r.status !== 202) throw new DeviceHttpError(await this.errText(r), r.status);
  }

  async waitForArrival(
    targetPanSteps: number, targetTiltSteps: number, timeoutMs: number,
  ): Promise<DeviceState> {
    const t0 = this.now();
    // allow the device a moment to set moving=1 before we test for arrival
    await new Promise((res) => setTimeout(res, 150));
    while (this.now() - t0 < timeoutMs) {
      const s = this.state;
      if (!s.moving &&
          Math.abs(s.panSteps - targetPanSteps) < ARRIVAL_TOL_STEPS &&
          Math.abs(s.tiltSteps - targetTiltSteps) < ARRIVAL_TOL_STEPS) {
        return { ...s };
      }
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(
      `goto timed out after ${timeoutMs}ms at pan=${(this.state.panSteps / STEPS_PER_DEG).toFixed(2)}° ` +
      `tilt=${(this.state.tiltSteps / STEPS_PER_DEG).toFixed(2)}°`,
    );
  }

  async stop(): Promise<void> {
    const r = await this.post("/api/stop");
    if (!r.ok) throw new Error(await this.errText(r));
  }

  async setHome(): Promise<void> {
    const r = await this.post("/api/home");
    if (r.status !== 202) throw new DeviceHttpError(await this.errText(r), r.status);
  }

  private sendJog(x: number, y: number, aux: number): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ x, y, aux }));
    }
  }

  private stopJogTimer(): void {
    if (this.jogTimer) { clearInterval(this.jogTimer); this.jogTimer = null; }
  }

  // The keep-alive. A vector older than its TTL means whoever set it stopped
  // proving it was alive — drop it and zero the rig rather than keep slewing.
  private pumpJog(): void {
    const v = this.jogVec;
    if (!v) { this.stopJogTimer(); return; }
    if (this.now() >= v.expiresAtMs) {
      this.jogVec = null;
      this.sendJog(0, 0, 0);
      this.stopJogTimer();
      return;
    }
    this.sendJog(v.x, v.y, v.aux);
  }

  // Set a sticky rate that is repeated to the device until it expires. The
  // caller MUST keep refreshing it; see pumpJog. `ttlMs` must be comfortably
  // greater than JOG_KEEPALIVE_MS (100ms): a TTL at or below the keep-alive
  // interval expires on the very first watchdog tick regardless of how fresh
  // the vector actually is -- it fails safe (stops early), but it will
  // silently defeat the caller's intent.
  //
  // The keep-alive interval is the ONLY sender: this call never writes to the
  // socket itself except to kick off the very first frame when the timer is
  // not already running. Subsequent calls (refreshing the vector/TTL while
  // the timer is alive) just update state -- pumpJog's own tick sends it.
  // This keeps exactly one frame in flight per JOG_KEEPALIVE_MS tick even
  // when a caller (jog()'s loop, or a future tracking session) invokes this
  // at roughly the keep-alive rate; sending here too would double it.
  setJogVector(x: number, y: number, aux: number, ttlMs: number): void {
    if (this.jogLocked) return;
    this.jogVec = { x, y, aux, expiresAtMs: this.now() + ttlMs };
    if (!this.jogTimer) {
      this.pumpJog();
      this.jogTimer = setInterval(() => this.pumpJog(), JOG_KEEPALIVE_MS);
    }
  }

  clearJog(): void {
    this.jogVec = null;
    this.stopJogTimer();
    this.sendJog(0, 0, 0);
  }

  // Driven by SunSupervisor's lock state (see setLocked). While latched, any
  // in-flight jog() keep-alive loop that re-calls setJogVector to refresh its
  // vector becomes a no-op, so the guard's clearJog() below cannot be undone
  // by a manual jog that was already running when the lock engaged.
  lockJog(): void {
    this.jogLocked = true;
    this.clearJog();
  }

  unlockJog(): void {
    this.jogLocked = false;
  }

  // Timed jog (the manual `jog` tool), built on the same vector so there is
  // exactly one keep-alive owner. Deliberately reads no clock: the loop is
  // bounded by tick count, so a test may freeze the injected clock without
  // hanging here. Cadence is governed by JOG_KEEPALIVE_MS, the same interval
  // the watchdog runs on, and every refreshed vector still carries a real
  // this.now()-policed TTL — so even a stuck jog is not exempt from expiry.
  async jog(x: number, y: number, aux: number, durationMs: number): Promise<void> {
    const ticks = Math.ceil(durationMs / JOG_KEEPALIVE_MS);
    this.setJogVector(x, y, aux, JOG_KEEPALIVE_MS * 5);
    for (let i = 0; i < ticks; i++) {
      await new Promise((res) => setTimeout(res, JOG_KEEPALIVE_MS));
      this.setJogVector(x, y, aux, JOG_KEEPALIVE_MS * 5);
    }
    this.clearJog();
  }

  async listPrograms(): Promise<{ current: number; names: string[]; selectable: boolean }> {
    const r = await fetch(`${this.httpBase()}/api/program`, {
      signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(await this.errText(r));
    return (await r.json()) as { current: number; names: string[]; selectable: boolean };
  }

  async selectProgram(index: number, commit: boolean): Promise<void> {
    const r = await this.post("/api/program", { type: index, select: commit });
    if (!r.ok) throw new Error(await this.errText(r));
  }

  async triggerCamera(action: "shoot" | "focus", ms: number): Promise<void> {
    const r = await this.post("/api/camera", { action, ms });
    if (!r.ok) throw new Error(await this.errText(r));
  }
}
