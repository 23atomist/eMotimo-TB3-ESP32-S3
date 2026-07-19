import { createServer, Server, IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const STEPS_PER_DEG = 444.444;
const SIM_DPS = 90; // simulated slew speed (deg/s), fast for tests

// The rig's measured full-deflection jog rate. Must match Config.maxJogDps.
export const MOCK_JOG_MAX_DPS = 19;
// The firmware's real deflection->rate curve, measured on hardware:
// axis_button_deadzone() zeroes |x|<6 and subtracts 5, then
// updateMotorVelocities2() applies a CUBIC ("exponential curve").
// Modelling this LINEARLY would make the sim validate a fiction -- a linear
// control mapping would look perfect here and be ~9x wrong on the rig.
const MOCK_JOY_DEADBAND = 5;
const MOCK_JOY_SPAN = 95;

// The firmware's cubic jog curve. Exported (pure, standalone) so tests can
// assert directly that it is the exact inverse of rateToDeflection
// (src/track/control.ts) -- the cheapest possible guard against the mock's
// model and the control law's model drifting apart.
export function mockJogRate(x: number, maxJogDps: number = MOCK_JOG_MAX_DPS): number {
  if (Math.abs(x) < 6) return 0;
  const db = Math.abs(x) - MOCK_JOY_DEADBAND;
  return Math.sign(x) * maxJogDps * Math.pow(db / MOCK_JOY_SPAN, 3);
}

// Mirrors the firmware's PROGRAM_NAMES table (src/tb3_web.cpp), which is sized
// by MENU_OPTIONS (9). The mock previously invented eight unrelated names,
// which made it agree with a daemon-side "0..7" bound that the firmware does
// not have -- and so hid the fact that WEBTRACK (8) was unreachable.
export const MOCK_PROGRAM_NAMES = [
  "New 2-Pt Move", "Rev 2-Pt Move", "New 3-Pt Move", "Rev 3-Pt Move",
  "Panorama", "Portrait Pano", "DF Slave", "Setup Menu", "Track (Web)",
] as const;

interface Body { [k: string]: unknown }

async function readJson(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

export class MockTb3 {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private moveTimer: NodeJS.Timeout | null = null;

  private pan = 0; private tilt = 0; private aux = 0;
  private targetPan = 0; private targetTilt = 0;
  // The firmware has ONE motorMoving bitmask, set by updateMotorVelocities2()
  // whenever a motor's velocity accumulator is non-zero -- a jog drives it
  // exactly as a goto does. These two are tracked apart only because a goto
  // move owns the axes and must suppress jog integration; everything the
  // device sees (telemetry `moving`, tb3_goto_safe()) reads isMoving().
  private gotoMoving = false;
  private jogMoving = false;
  private programEngaged = false;
  // The joystick state the firmware is currently acting on (s_joy_x/y/aux).
  // Distinct from `lastJog`, which is the test-visible record of the last frame
  // received: /api/stop zeroes what the rig acts on without erasing that record.
  private jogCmd: { x: number; y: number; aux: number } | null = null;

  lastGoto: { pan_deg: number; tilt_deg: number; speed_dps?: number } | null = null;
  lastJog: { x: number; y: number; aux: number } | null = null;
  lastCamera: { action: string; ms: number } | null = null;
  lastProgram: { type: number; select: boolean } | null = null;
  stopCount = 0;
  homeCount = 0;

  setPosition(panSteps: number, tiltSteps: number, auxSteps = 0): void {
    this.pan = panSteps; this.tilt = tiltSteps; this.aux = auxSteps;
    this.targetPan = panSteps; this.targetTilt = tiltSteps;
  }
  setProgramEngaged(v: boolean): void { this.programEngaged = v; }

  async start(port: number): Promise<void> {
    this.http = createServer((req, res) => this.route(req, res));
    this.wss = new WebSocketServer({ server: this.http, path: "/ws" });
    this.wss.on("connection", (ws) => {
      ws.on("message", (buf) => {
        try {
          const d = JSON.parse(buf.toString());
          if (typeof d.x === "number" || typeof d.y === "number") {
            const frame = { x: d.x ?? 0, y: d.y ?? 0, aux: d.aux ?? 0 };
            this.lastJog = frame;
            this.jogCmd = frame;
          }
        } catch { /* ignore */ }
      });
    });
    this.tickTimer = setInterval(() => { this.applyJog(); this.pushTick(); }, 50);
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.http!.removeListener("error", onError);
        this.wss!.removeListener("error", onError);
        if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
        reject(err);
      };
      // `ws` re-emits the underlying http server's 'error' as its own
      // 'error' event on the WebSocketServer instance (see
      // node_modules/ws/lib/websocket-server.js). With no listener there,
      // that re-emission throws synchronously (EventEmitter's unhandled
      // 'error' special case) before this http-level listener ever runs, so
      // both must be wired to actually catch a bind failure.
      this.http!.once("error", onError);
      this.wss!.once("error", onError);
      this.http!.listen(port, "127.0.0.1", () => {
        this.http!.removeListener("error", onError);
        this.wss!.removeListener("error", onError);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.moveTimer) clearInterval(this.moveTimer);
    this.wss?.clients.forEach((c) => c.terminate());
    if (this.wss) { await new Promise<void>((resolve) => this.wss!.close(() => resolve())); }
    if (this.http) { await new Promise<void>((resolve) => this.http!.close(() => resolve())); }
  }

  private json(res: ServerResponse, code: number, body: object): void {
    const s = JSON.stringify(body);
    res.writeHead(code, { "content-type": "application/json" });
    res.end(s);
  }

  /** What the firmware reports as motorMoving: any axis under power, jog or goto. */
  private isMoving(): boolean { return this.gotoMoving || this.jogMoving; }

  // tb3_goto_safe() == !Program_Engaged && motorMoving == 0 (TB3_WebGlue.ino).
  private safe(): boolean { return !this.programEngaged && !this.isMoving(); }

  // Integrate the standing jog vector into position, so a commanded rate
  // actually moves the mock. A goto move takes precedence over jog.
  //
  // A non-zero jog rate sets motorMoving on the real rig, which makes
  // tb3_goto_safe() false and 409s any goto until the rig has decelerated.
  // Modelling only the goto here let a *jogging* mock report moving:false and
  // sail through safe(), hiding every 409 the reacquire path actually earns.
  //
  // NOTE: this still deliberately does NOT model the firmware's acceleration
  // ramp (updateMotorVelocities2 ramps the accumulator at (65535/20)/1.0 per
  // 20Hz cycle, ~1s to plateau -- see src/TB3_Nunchuck.ino:497,521). Out of
  // scope for v1: it bounds how fast the servo can correct but does not bias
  // steady-state rate. The sim's error tolerance absorbs the simplification.
  // Consequently jogMoving clears the instant a zero frame lands, where the
  // rig needs ~450ms of ramp-down -- see decelMs() in src/track/control.ts.
  private applyJog(): void {
    if (this.gotoMoving) return;
    const j = this.jogCmd;
    const panDps = j ? mockJogRate(j.x) : 0;
    const tiltDps = j ? mockJogRate(j.y) : 0;
    this.jogMoving = panDps !== 0 || tiltDps !== 0;
    this.pan += panDps * STEPS_PER_DEG * 0.05;
    this.tilt += tiltDps * STEPS_PER_DEG * 0.05;
  }

  private startMove(panDeg: number, tiltDeg: number): void {
    this.targetPan = panDeg * STEPS_PER_DEG;
    this.targetTilt = tiltDeg * STEPS_PER_DEG;
    this.gotoMoving = true;
    if (this.moveTimer) clearInterval(this.moveTimer);
    const stepPerTick = SIM_DPS * STEPS_PER_DEG * 0.05; // steps per 50ms
    this.moveTimer = setInterval(() => {
      const dp = this.targetPan - this.pan;
      const dt = this.targetTilt - this.tilt;
      this.pan += Math.sign(dp) * Math.min(Math.abs(dp), stepPerTick);
      this.tilt += Math.sign(dt) * Math.min(Math.abs(dt), stepPerTick);
      if (Math.abs(this.targetPan - this.pan) < 1 && Math.abs(this.targetTilt - this.tilt) < 1) {
        this.pan = this.targetPan; this.tilt = this.targetTilt;
        this.gotoMoving = false;
        if (this.moveTimer) { clearInterval(this.moveTimer); this.moveTimer = null; }
      }
    }, 50);
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    if (method === "GET" && url === "/api/status") {
      return this.json(res, 200, {
        pos: { pan: this.pan, tilt: this.tilt, aux: this.aux },
        moving: this.isMoving() ? 1 : 0,
        program_engaged: this.programEngaged,
        battery_v: 12.3,
        wifi: { ap_ip: "10.31.31.1", sta_ip: "192.168.1.50" },
      });
    }
    if (method === "GET" && url === "/api/program") {
      return this.json(res, 200, { current: 0, names: [...MOCK_PROGRAM_NAMES], selectable: true });
    }
    if (method === "POST" && url === "/api/goto") {
      const b = await readJson(req);
      // Firmware parity (src/tb3_web.cpp): tb3_goto_safe() has TWO causes, and
      // it names which one fired rather than blaming "program engaged" when
      // the far more common cause is simply the rig still decelerating.
      if (!this.safe()) {
        return this.json(res, 409, {
          error: this.programEngaged
            ? "busy - program engaged"
            : "busy - motors still moving; retry once status moving==0",
        });
      }
      const pan_deg = Number(b.pan_deg), tilt_deg = Number(b.tilt_deg);
      if (!Number.isFinite(pan_deg) || !Number.isFinite(tilt_deg)) {
        return this.json(res, 400, { error: "pan_deg/tilt_deg required" });
      }
      this.lastGoto = { pan_deg, tilt_deg, speed_dps: b.speed_dps as number | undefined };
      this.startMove(pan_deg, tilt_deg);
      return this.json(res, 202, { ok: true });
    }
    if (method === "POST" && url === "/api/home") {
      if (!this.safe()) return this.json(res, 409, { error: "busy" });
      this.homeCount++;
      this.setPosition(0, 0, 0);
      return this.json(res, 202, { ok: true });
    }
    if (method === "POST" && url === "/api/stop") {
      this.stopCount++;
      // Firmware parity (src/tb3_web.cpp): /api/stop zeroes the joystick state
      // the rig acts on as well as hard-stopping the move. `lastJog` is left
      // alone -- it is the record of frames received, not the live command.
      this.gotoMoving = false;
      this.jogMoving = false;
      this.jogCmd = null;
      if (this.moveTimer) { clearInterval(this.moveTimer); this.moveTimer = null; }
      return this.json(res, 200, { ok: true });
    }
    if (method === "POST" && url === "/api/program") {
      const b = await readJson(req);
      const type = Number(b.type);
      // Firmware parity (src/tb3_web.cpp): the bound is derived from the menu
      // table, not a literal, and out-of-range is a 400 naming the real range.
      const last = MOCK_PROGRAM_NAMES.length - 1;
      if (!Number.isInteger(type) || type < 0 || type > last) {
        return this.json(res, 400, { error: `type must be 0..${last}` });
      }
      this.lastProgram = { type, select: Boolean(b.select) };
      return this.json(res, 200, { ok: true });
    }
    if (method === "POST" && url === "/api/camera") {
      const b = await readJson(req);
      const action = String(b.action);
      if (action !== "shoot" && action !== "focus") {
        return this.json(res, 400, { error: "action must be shoot or focus" });
      }
      this.lastCamera = { action, ms: Number(b.ms ?? 150) };
      return this.json(res, 200, { ok: true });
    }
    this.json(res, 404, { error: "not found" });
  }

  private pushTick(): void {
    if (!this.wss) return;
    const tick = JSON.stringify({
      type: "tick",
      lcd: ["MOCK", "TB3"],
      pos: [Math.round(this.pan), Math.round(this.tilt), Math.round(this.aux)],
      moving: this.isMoving() ? 1 : 0,
      prog: this.programEngaged ? 1 : 0,
      fired: 0, total: 0, batt: 12.3,
      sta: "192.168.1.50",
      imu: { ok: true, pitch: 1.5, roll: -2.0, tempC: 25.4, pressHpa: 1013.1 },
    });
    this.wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(tick); });
  }
}
