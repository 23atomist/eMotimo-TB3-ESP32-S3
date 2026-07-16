import WebSocket from "ws";
import { Config } from "./config.js";
import { DeviceState } from "./types.js";
import { STEPS_PER_DEG } from "./angles.js";

const ARRIVAL_TOL_STEPS = 0.25 * STEPS_PER_DEG;

export class Device {
  private cfg: Config;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private state: DeviceState = {
    connected: false, panSteps: 0, tiltSteps: 0, auxSteps: 0,
    moving: false, programEngaged: false, batteryV: 0, staIp: "", lastUpdateMs: 0,
  };

  constructor(cfg: Config) { this.cfg = cfg; }

  private httpBase(): string { return `http://${this.cfg.deviceHost}`; }
  private wsUrl(): string { return `ws://${this.cfg.deviceHost}/ws`; }

  start(): void {
    this.closed = false;
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
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
      this.state.lastUpdateMs = Date.now();
    } catch { /* ignore malformed tick */ }
  }

  private async post(path: string, body?: object): Promise<Response> {
    return fetch(`${this.httpBase()}${path}`, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
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
    if (r.status !== 202) throw new Error(await this.errText(r));
  }

  async waitForArrival(
    targetPanSteps: number, targetTiltSteps: number, timeoutMs: number,
  ): Promise<DeviceState> {
    const t0 = Date.now();
    // allow the device a moment to set moving=1 before we test for arrival
    await new Promise((res) => setTimeout(res, 150));
    while (Date.now() - t0 < timeoutMs) {
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
    if (r.status !== 202) throw new Error(await this.errText(r));
  }

  async jog(x: number, y: number, aux: number, durationMs: number): Promise<void> {
    const send = (fx: number, fy: number, fa: number) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ x: fx, y: fy, aux: fa }));
      }
    };
    const t0 = Date.now();
    send(x, y, aux);
    while (Date.now() - t0 < durationMs) {
      await new Promise((res) => setTimeout(res, 100));
      send(x, y, aux);
    }
    send(0, 0, 0);
  }

  async listPrograms(): Promise<{ current: number; names: string[]; selectable: boolean }> {
    const r = await fetch(`${this.httpBase()}/api/program`);
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
