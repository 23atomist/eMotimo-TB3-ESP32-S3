# TB3 MCP Control Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an always-on TypeScript/Node MCP daemon that lets any LLM read and drive the eMotimo TB3 (status, jog, stop, set-home, programs, camera, and absolute pan/tilt goto), plus the two firmware endpoints (`/api/goto`, `/api/home`) the goto/home tools require.

**Architecture:** A `tb3-mcp/` Node project holds a device client (persistent WebSocket telemetry + HTTP commands, with a cached state and auto-reconnect) fused with an MCP server over streamable HTTP/SSE. Pure conversion/limit math and config are isolated, unit-tested files. A mock TB3 (fake HTTP+WS server with a motion simulator) makes the whole daemon testable with no hardware. Firmware adds two small endpoints that reuse the existing coordinated-move engine and the deferred-write web-glue discipline.

**Tech Stack:** Node ≥ 20, TypeScript (strict), `@modelcontextprotocol/sdk@^1`, `zod@^3.23`, `express@^4`, `ws@^8`, `vitest@^2`, `tsx`. Firmware: Arduino / pioarduino (ESP32-S3), ESPAsyncWebServer, ArduinoJson.

## Global Constraints

Every task's requirements implicitly include this section. Copy exact values verbatim.

- **Steps↔degrees:** `STEPS_PER_DEG = 444.444`. Device reports position in **raw steps**; the daemon converts to degrees.
- **Axis mapping:** `current_steps.x` = pan, `.y` = tilt, `.z` = aux.
- **Device HTTP/WS contract (both firmware and mock implement identically):**
  - `GET /api/status` → JSON incl. `pos:{pan,tilt,aux}` (steps, float), `moving` (int), `program_engaged` (bool), `battery_v`, `wifi:{ap_ip,sta_ip}`.
  - `WS /ws`: server pushes 5 Hz `{"type":"tick","lcd":[l1,l2],"pos":[pan,tilt,aux],"moving":<int>,"prog":<0|1>,"fired":<int>,"total":<int>,"batt":<float>,"sta":"<ip>"}` (pos in **steps**, `prog` = program_engaged). Client sends joystick `{"x":<-100..100>,"y":..,"aux":..}`.
  - `POST /api/stop` → `{"ok":true}`.
  - `GET /api/program` → `{"current":<int>,"names":[8 strings],"selectable":<bool>}`.
  - `POST /api/program` `{"type":<0..7>,"select":<bool>}` → `{"ok":true}` | `409`.
  - `POST /api/camera` `{"action":"shoot"|"focus","ms":<int>}` → `{"ok":true}` | `400`.
  - **NEW** `POST /api/goto` `{"pan_deg":<float>,"tilt_deg":<float>,"speed_dps":<float?>}` → `202 {"ok":true}` | `409 {"error":"busy - program engaged"}` | `400 {"error":...}`.
  - **NEW** `POST /api/home` (no body) → `202 {"ok":true}` | `409 {"error":"busy"}`.
- **Default soft limits (config defaults):** `pan_min=-180, pan_max=180, tilt_min=-90, tilt_max=90, max_speed_dps=30, max_jog_dps=20`. Out-of-range pan/tilt or speed → **tool error, never a silent clamp**.
- **Firmware discipline:** a network-task route MUST NOT call motion code directly. It sets `static volatile` pending state drained by `tb3_web_poll()` on loopTask. Web-glue: declare prototype in `src/tb3_web.h`, define body in `src/TB3_WebGlue.ino`.
- **Firmware safety gate for goto/home:** `!Program_Engaged && motorMoving == 0` (else `409`). Enable motors with `enable_PT(); enable_AUX();` before a move.
- **No secrets in code.** The optional MCP bearer token comes from config/env only.
- **Daemon lives in** `tb3-mcp/` at repo root. All daemon paths below are relative to it unless prefixed with `src/` (firmware).

---

### Task 1: Scaffold + pure angle/limit math

**Files:**
- Create: `tb3-mcp/package.json`, `tb3-mcp/tsconfig.json`, `tb3-mcp/vitest.config.ts`, `tb3-mcp/.gitignore`
- Create: `tb3-mcp/src/angles.ts`, `tb3-mcp/src/types.ts`
- Test: `tb3-mcp/test/angles.test.ts`

**Interfaces:**
- Produces:
  - `STEPS_PER_DEG: number` (= 444.444)
  - `stepsToDeg(steps: number): number`, `degToSteps(deg: number): number`
  - `applySign(deg: number, sign: number): number` (sign ∈ {1,-1}; converts between device and user frame — self-inverse)
  - `interface Limits { panMin: number; panMax: number; tiltMin: number; tiltMax: number; maxSpeedDps: number }`
  - `checkPanTilt(userPanDeg: number, userTiltDeg: number, limits: Limits): { ok: boolean; error?: string }`
  - `checkSpeed(speedDps: number | undefined, maxDps: number): { ok: boolean; error?: string }`
  - `types.ts`: `interface DeviceState { connected: boolean; panSteps: number; tiltSteps: number; auxSteps: number; moving: boolean; programEngaged: boolean; batteryV: number; staIp: string; lastUpdateMs: number }`

- [ ] **Step 1: Create `tb3-mcp/package.json`**

```json
{
  "name": "tb3-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "dev": "tsx src/server.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1",
    "express": "^4",
    "ws": "^8",
    "zod": "^3.23"
  },
  "devDependencies": {
    "@types/express": "^4",
    "@types/node": "^20",
    "@types/ws": "^8",
    "tsx": "^4",
    "typescript": "^5",
    "vitest": "^2"
  }
}
```

- [ ] **Step 2: Create `tb3-mcp/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `tb3-mcp/vitest.config.ts` and `tb3-mcp/.gitignore`**

`tb3-mcp/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 10000,
  },
});
```

`tb3-mcp/.gitignore`:
```
node_modules/
dist/
config.json
```

- [ ] **Step 4: Install dependencies**

Run: `cd tb3-mcp && npm install`
Expected: `node_modules/` created, no peer-dependency errors.

- [ ] **Step 5: Write the failing test** — `tb3-mcp/test/angles.test.ts`

```ts
import { describe, it, expect } from "vitest";
import {
  STEPS_PER_DEG, stepsToDeg, degToSteps, applySign,
  checkPanTilt, checkSpeed, Limits,
} from "../src/angles.js";

const limits: Limits = { panMin: -180, panMax: 180, tiltMin: -90, tiltMax: 90, maxSpeedDps: 30 };

describe("angle conversions", () => {
  it("STEPS_PER_DEG is 444.444", () => {
    expect(STEPS_PER_DEG).toBeCloseTo(444.444, 3);
  });
  it("stepsToDeg / degToSteps round-trip", () => {
    expect(stepsToDeg(444.444)).toBeCloseTo(1, 6);
    expect(degToSteps(90)).toBeCloseTo(40000, 0); // 90 * 444.444
    expect(stepsToDeg(degToSteps(37.5))).toBeCloseTo(37.5, 6);
  });
  it("applySign is self-inverse for -1 and identity for 1", () => {
    expect(applySign(12.5, 1)).toBe(12.5);
    expect(applySign(12.5, -1)).toBe(-12.5);
    expect(applySign(applySign(12.5, -1), -1)).toBe(12.5);
  });
});

describe("limit checks", () => {
  it("accepts in-range pan/tilt", () => {
    expect(checkPanTilt(90, 45, limits).ok).toBe(true);
  });
  it("refuses pan above max with a descriptive error", () => {
    const r = checkPanTilt(200, 0, limits);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("pan");
  });
  it("refuses tilt below min", () => {
    expect(checkPanTilt(0, -100, limits).ok).toBe(false);
  });
  it("refuses non-finite input", () => {
    expect(checkPanTilt(Number.NaN, 0, limits).ok).toBe(false);
  });
});

describe("speed checks", () => {
  it("accepts undefined (use device max)", () => {
    expect(checkSpeed(undefined, 30).ok).toBe(true);
  });
  it("accepts in-range speed", () => {
    expect(checkSpeed(10, 30).ok).toBe(true);
  });
  it("refuses speed above max", () => {
    expect(checkSpeed(50, 30).ok).toBe(false);
  });
  it("refuses zero or negative speed", () => {
    expect(checkSpeed(0, 30).ok).toBe(false);
    expect(checkSpeed(-5, 30).ok).toBe(false);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd tb3-mcp && npm test`
Expected: FAIL — cannot resolve `../src/angles.js`.

- [ ] **Step 7: Create `tb3-mcp/src/types.ts`**

```ts
export interface DeviceState {
  connected: boolean;
  panSteps: number;
  tiltSteps: number;
  auxSteps: number;
  moving: boolean;
  programEngaged: boolean;
  batteryV: number;
  staIp: string;
  lastUpdateMs: number;
}
```

- [ ] **Step 8: Create `tb3-mcp/src/angles.ts`**

```ts
export const STEPS_PER_DEG = 444.444;

export function stepsToDeg(steps: number): number {
  return steps / STEPS_PER_DEG;
}

export function degToSteps(deg: number): number {
  return deg * STEPS_PER_DEG;
}

// Device frame ↔ user frame. sign is +1 or -1; multiplying is its own inverse.
export function applySign(deg: number, sign: number): number {
  return deg * sign;
}

export interface Limits {
  panMin: number;
  panMax: number;
  tiltMin: number;
  tiltMax: number;
  maxSpeedDps: number;
}

export function checkPanTilt(
  userPanDeg: number,
  userTiltDeg: number,
  limits: Limits,
): { ok: boolean; error?: string } {
  if (!Number.isFinite(userPanDeg) || !Number.isFinite(userTiltDeg)) {
    return { ok: false, error: "pan_deg and tilt_deg must be finite numbers" };
  }
  if (userPanDeg < limits.panMin || userPanDeg > limits.panMax) {
    return {
      ok: false,
      error: `pan ${userPanDeg}° is outside the allowed range [${limits.panMin}, ${limits.panMax}]`,
    };
  }
  if (userTiltDeg < limits.tiltMin || userTiltDeg > limits.tiltMax) {
    return {
      ok: false,
      error: `tilt ${userTiltDeg}° is outside the allowed range [${limits.tiltMin}, ${limits.tiltMax}]`,
    };
  }
  return { ok: true };
}

export function checkSpeed(
  speedDps: number | undefined,
  maxDps: number,
): { ok: boolean; error?: string } {
  if (speedDps === undefined) return { ok: true };
  if (!Number.isFinite(speedDps) || speedDps <= 0) {
    return { ok: false, error: "speed_dps must be a positive number" };
  }
  if (speedDps > maxDps) {
    return { ok: false, error: `speed ${speedDps}°/s exceeds max ${maxDps}°/s` };
  }
  return { ok: true };
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd tb3-mcp && npm test`
Expected: PASS — all `angles.test.ts` cases green.

- [ ] **Step 10: Commit**

```bash
git add tb3-mcp/package.json tb3-mcp/package-lock.json tb3-mcp/tsconfig.json tb3-mcp/vitest.config.ts tb3-mcp/.gitignore tb3-mcp/src/angles.ts tb3-mcp/src/types.ts tb3-mcp/test/angles.test.ts
git commit -m "feat(mcp): scaffold tb3-mcp + pure angle/limit math"
```

---

### Task 2: Config loader

**Files:**
- Create: `tb3-mcp/src/config.ts`, `tb3-mcp/config.example.json`
- Test: `tb3-mcp/test/config.test.ts`

**Interfaces:**
- Consumes: `Limits` (angles.ts) — not required, config produces its own shape.
- Produces:
  - `interface Config { deviceHost: string; deviceIpFallback?: string; mcpPort: number; mcpToken?: string; panMin: number; panMax: number; tiltMin: number; tiltMax: number; maxSpeedDps: number; maxJogDps: number; panSign: number; tiltSign: number; auxSign: number }`
  - `loadConfig(filePath?: string, env?: NodeJS.ProcessEnv): Config` — reads JSON file if present, applies env overrides, validates with zod, fills defaults.

- [ ] **Step 1: Write the failing test** — `tb3-mcp/test/config.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("returns defaults when no file and no env", () => {
    const c = loadConfig(undefined, {});
    expect(c.deviceHost).toBe("tb3.local");
    expect(c.mcpPort).toBe(8770);
    expect(c.panMin).toBe(-180);
    expect(c.panMax).toBe(180);
    expect(c.tiltMin).toBe(-90);
    expect(c.tiltMax).toBe(90);
    expect(c.maxSpeedDps).toBe(30);
    expect(c.maxJogDps).toBe(20);
    expect(c.panSign).toBe(1);
    expect(c.mcpToken).toBeUndefined();
  });

  it("applies env overrides over defaults", () => {
    const c = loadConfig(undefined, {
      TB3_DEVICE_HOST: "10.31.31.1",
      TB3_MCP_PORT: "9999",
      TB3_MCP_TOKEN: "secret",
      TB3_MAX_SPEED_DPS: "12",
    });
    expect(c.deviceHost).toBe("10.31.31.1");
    expect(c.mcpPort).toBe(9999);
    expect(c.mcpToken).toBe("secret");
    expect(c.maxSpeedDps).toBe(12);
  });

  it("rejects an invalid sign", () => {
    expect(() => loadConfig(undefined, { TB3_PAN_SIGN: "2" })).toThrow();
  });

  it("rejects pan_min >= pan_max", () => {
    expect(() => loadConfig(undefined, { TB3_PAN_MIN: "50", TB3_PAN_MAX: "10" })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tb3-mcp && npm test -- config`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 3: Create `tb3-mcp/src/config.ts`**

```ts
import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";

const sign = z.union([z.literal(1), z.literal(-1)]);

const ConfigSchema = z
  .object({
    deviceHost: z.string().min(1).default("tb3.local"),
    deviceIpFallback: z.string().optional(),
    mcpPort: z.number().int().positive().default(8770),
    mcpToken: z.string().min(1).optional(),
    panMin: z.number().default(-180),
    panMax: z.number().default(180),
    tiltMin: z.number().default(-90),
    tiltMax: z.number().default(90),
    maxSpeedDps: z.number().positive().default(30),
    maxJogDps: z.number().positive().default(20),
    panSign: sign.default(1),
    tiltSign: sign.default(1),
    auxSign: sign.default(1),
  })
  .refine((c) => c.panMin < c.panMax, { message: "panMin must be < panMax" })
  .refine((c) => c.tiltMin < c.tiltMax, { message: "tiltMin must be < tiltMax" });

export type Config = z.infer<typeof ConfigSchema>;

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`invalid number: ${v}`);
  return n;
}

export function loadConfig(
  filePath?: string,
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const fromFile: Record<string, unknown> =
    filePath && existsSync(filePath)
      ? JSON.parse(readFileSync(filePath, "utf8"))
      : {};

  const overrides: Record<string, unknown> = { ...fromFile };
  const set = (key: string, value: unknown) => {
    if (value !== undefined) overrides[key] = value;
  };

  set("deviceHost", env.TB3_DEVICE_HOST);
  set("deviceIpFallback", env.TB3_DEVICE_IP_FALLBACK);
  set("mcpPort", num(env.TB3_MCP_PORT));
  set("mcpToken", env.TB3_MCP_TOKEN);
  set("panMin", num(env.TB3_PAN_MIN));
  set("panMax", num(env.TB3_PAN_MAX));
  set("tiltMin", num(env.TB3_TILT_MIN));
  set("tiltMax", num(env.TB3_TILT_MAX));
  set("maxSpeedDps", num(env.TB3_MAX_SPEED_DPS));
  set("maxJogDps", num(env.TB3_MAX_JOG_DPS));
  set("panSign", num(env.TB3_PAN_SIGN));
  set("tiltSign", num(env.TB3_TILT_SIGN));
  set("auxSign", num(env.TB3_AUX_SIGN));

  return ConfigSchema.parse(overrides);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tb3-mcp && npm test -- config`
Expected: PASS.

- [ ] **Step 5: Create `tb3-mcp/config.example.json`**

```json
{
  "deviceHost": "tb3.local",
  "deviceIpFallback": "10.31.31.1",
  "mcpPort": 8770,
  "panMin": -180,
  "panMax": 180,
  "tiltMin": -90,
  "tiltMax": 90,
  "maxSpeedDps": 30,
  "maxJogDps": 20,
  "panSign": 1,
  "tiltSign": 1,
  "auxSign": 1
}
```

- [ ] **Step 6: Commit**

```bash
git add tb3-mcp/src/config.ts tb3-mcp/config.example.json tb3-mcp/test/config.test.ts
git commit -m "feat(mcp): config loader with file + env overrides"
```

---

### Task 3: Mock TB3 (test infrastructure)

**Files:**
- Create: `tb3-mcp/test/mock-tb3.ts`
- Test: `tb3-mcp/test/mock-tb3.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `class MockTb3` with:
    - `async start(port: number): Promise<void>` (listens on `127.0.0.1:port`, HTTP + `/ws`)
    - `async stop(): Promise<void>`
    - `setPosition(panSteps: number, tiltSteps: number, auxSteps?: number): void`
    - `setProgramEngaged(v: boolean): void`
    - fields for assertions: `lastGoto: { pan_deg: number; tilt_deg: number; speed_dps?: number } | null`, `lastJog: { x: number; y: number; aux: number } | null`, `stopCount: number`, `homeCount: number`, `lastCamera: { action: string; ms: number } | null`, `lastProgram: { type: number; select: boolean } | null`
  - Motion simulation: on `POST /api/goto`, records it, sets `moving=1`, and advances position toward target ~90°/s of simulated travel via a 50 ms interval, clearing `moving` on arrival. On `POST /api/home`, zeroes position. On `POST /api/stop`, halts motion. Pushes the 5 Hz-style telemetry tick every 50 ms to all `/ws` clients (faster than hardware to keep tests quick).

- [ ] **Step 1: Write the failing test** — `tb3-mcp/test/mock-tb3.test.ts`

```ts
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { MockTb3 } from "./mock-tb3.js";

const PORT = 8791;
let mock: MockTb3 | null = null;

afterEach(async () => {
  if (mock) { await mock.stop(); mock = null; }
});

function once(ws: WebSocket, event: "open" | "message"): Promise<any> {
  return new Promise((resolve) => ws.once(event, resolve));
}

describe("MockTb3", () => {
  it("serves GET /api/status with position in steps", async () => {
    mock = new MockTb3();
    await mock.start(PORT);
    mock.setPosition(44444.4, 0);
    const r = await fetch(`http://127.0.0.1:${PORT}/api/status`);
    const j = await r.json();
    expect(j.pos.pan).toBeCloseTo(44444.4, 0);
    expect(j.program_engaged).toBe(false);
  });

  it("pushes telemetry ticks over /ws", async () => {
    mock = new MockTb3();
    await mock.start(PORT);
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await once(ws, "open");
    const msg = await once(ws, "message");
    const tick = JSON.parse(msg.toString());
    expect(tick.type).toBe("tick");
    expect(Array.isArray(tick.pos)).toBe(true);
    ws.close();
  });

  it("simulates a goto: records it, moves, then stops moving", async () => {
    mock = new MockTb3();
    await mock.start(PORT);
    mock.setPosition(0, 0);
    const r = await fetch(`http://127.0.0.1:${PORT}/api/goto`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pan_deg: 10, tilt_deg: 0 }),
    });
    expect(r.status).toBe(202);
    expect(mock.lastGoto).toEqual({ pan_deg: 10, tilt_deg: 0, speed_dps: undefined });
    // poll status until arrival
    let arrived = false;
    for (let i = 0; i < 100 && !arrived; i++) {
      await new Promise((res) => setTimeout(res, 50));
      const s = await (await fetch(`http://127.0.0.1:${PORT}/api/status`)).json();
      arrived = s.moving === 0 && Math.abs(s.pos.pan - 10 * 444.444) < 200;
    }
    expect(arrived).toBe(true);
  });

  it("returns 409 for goto while a program is engaged", async () => {
    mock = new MockTb3();
    await mock.start(PORT);
    mock.setProgramEngaged(true);
    const r = await fetch(`http://127.0.0.1:${PORT}/api/goto`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pan_deg: 1, tilt_deg: 0 }),
    });
    expect(r.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tb3-mcp && npm test -- mock-tb3`
Expected: FAIL — cannot resolve `./mock-tb3.js`.

- [ ] **Step 3: Create `tb3-mcp/test/mock-tb3.ts`**

```ts
import { createServer, Server, IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const STEPS_PER_DEG = 444.444;
const SIM_DPS = 90; // simulated slew speed (deg/s), fast for tests

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
  private moving = false;
  private programEngaged = false;

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
            this.lastJog = { x: d.x ?? 0, y: d.y ?? 0, aux: d.aux ?? 0 };
          }
        } catch { /* ignore */ }
      });
    });
    this.tickTimer = setInterval(() => this.pushTick(), 50);
    await new Promise<void>((resolve) => this.http!.listen(port, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.moveTimer) clearInterval(this.moveTimer);
    this.wss?.clients.forEach((c) => c.terminate());
    await new Promise<void>((resolve) => this.wss?.close(() => resolve()));
    await new Promise<void>((resolve) => this.http?.close(() => resolve()));
  }

  private json(res: ServerResponse, code: number, body: object): void {
    const s = JSON.stringify(body);
    res.writeHead(code, { "content-type": "application/json" });
    res.end(s);
  }

  private safe(): boolean { return !this.programEngaged && !this.moving; }

  private startMove(panDeg: number, tiltDeg: number): void {
    this.targetPan = panDeg * STEPS_PER_DEG;
    this.targetTilt = tiltDeg * STEPS_PER_DEG;
    this.moving = true;
    if (this.moveTimer) clearInterval(this.moveTimer);
    const stepPerTick = SIM_DPS * STEPS_PER_DEG * 0.05; // steps per 50ms
    this.moveTimer = setInterval(() => {
      const dp = this.targetPan - this.pan;
      const dt = this.targetTilt - this.tilt;
      this.pan += Math.sign(dp) * Math.min(Math.abs(dp), stepPerTick);
      this.tilt += Math.sign(dt) * Math.min(Math.abs(dt), stepPerTick);
      if (Math.abs(this.targetPan - this.pan) < 1 && Math.abs(this.targetTilt - this.tilt) < 1) {
        this.pan = this.targetPan; this.tilt = this.targetTilt;
        this.moving = false;
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
        moving: this.moving ? 1 : 0,
        program_engaged: this.programEngaged,
        battery_v: 12.3,
        wifi: { ap_ip: "10.31.31.1", sta_ip: "192.168.1.50" },
      });
    }
    if (method === "GET" && url === "/api/program") {
      return this.json(res, 200, {
        current: 0,
        names: ["SMS", "Video", "Pano", "3PT", "P1", "P2", "P3", "P4"],
        selectable: true,
      });
    }
    if (method === "POST" && url === "/api/goto") {
      const b = await readJson(req);
      if (!this.safe()) return this.json(res, 409, { error: "busy - program engaged" });
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
      this.moving = false;
      if (this.moveTimer) { clearInterval(this.moveTimer); this.moveTimer = null; }
      return this.json(res, 200, { ok: true });
    }
    if (method === "POST" && url === "/api/program") {
      const b = await readJson(req);
      this.lastProgram = { type: Number(b.type), select: Boolean(b.select) };
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
      moving: this.moving ? 1 : 0,
      prog: this.programEngaged ? 1 : 0,
      fired: 0, total: 0, batt: 12.3,
      sta: "192.168.1.50",
    });
    this.wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(tick); });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tb3-mcp && npm test -- mock-tb3`
Expected: PASS — all 4 MockTb3 cases green.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/test/mock-tb3.ts tb3-mcp/test/mock-tb3.test.ts
git commit -m "test(mcp): mock TB3 http+ws server with motion sim"
```

---

### Task 4: Device client

**Files:**
- Create: `tb3-mcp/src/device.ts`
- Test: `tb3-mcp/test/device.test.ts`

**Interfaces:**
- Consumes: `Config` (config.ts), `DeviceState` (types.ts), `STEPS_PER_DEG` (angles.ts), `MockTb3` (test only).
- Produces:
  - `class Device`:
    - `constructor(cfg: Config)`
    - `start(): void` — opens the WS and begins auto-reconnect.
    - `close(): void`
    - `getState(): DeviceState`
    - `async gotoAngle(devicePanDeg: number, deviceTiltDeg: number, speedDps?: number): Promise<void>` — `POST /api/goto`; throws `Error` on non-202 (message = server `error` field).
    - `async waitForArrival(targetPanSteps: number, targetTiltSteps: number, timeoutMs: number): Promise<DeviceState>` — resolves when `!moving` and each axis within `0.25°`; rejects `Error("goto timed out ...")` on timeout.
    - `async stop(): Promise<void>` — `POST /api/stop`.
    - `async setHome(): Promise<void>` — `POST /api/home`; throws on non-2xx.
    - `async jog(x: number, y: number, aux: number, durationMs: number): Promise<void>` — streams WS joystick frames every 100 ms for the duration, then a zero frame.
    - `async listPrograms(): Promise<{ current: number; names: string[]; selectable: boolean }>` — `GET /api/program`.
    - `async selectProgram(index: number, commit: boolean): Promise<void>` — `POST /api/program {type:index, select:commit}`.
    - `async triggerCamera(action: "shoot" | "focus", ms: number): Promise<void>` — `POST /api/camera`.

- [ ] **Step 1: Write the failing test** — `tb3-mcp/test/device.test.ts`

```ts
import { describe, it, expect, afterEach } from "vitest";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";

const PORT = 8792;
let mock: MockTb3 | null = null;
let dev: Device | null = null;

function makeDevice(): Device {
  const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}` });
  return new Device(cfg);
}

afterEach(async () => {
  dev?.close(); dev = null;
  if (mock) { await mock.stop(); mock = null; }
});

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
  if (!pred()) throw new Error("waitFor timed out");
}

describe("Device", () => {
  it("caches telemetry from the WS feed", async () => {
    mock = new MockTb3(); await mock.start(PORT);
    mock.setPosition(444.444 * 30, 0);
    dev = makeDevice(); dev.start();
    await waitFor(() => dev!.getState().connected && dev!.getState().panSteps > 0);
    expect(dev.getState().panSteps).toBeCloseTo(444.444 * 30, -1);
    expect(dev.getState().moving).toBe(false);
  });

  it("gotoAngle triggers a move that waitForArrival resolves", async () => {
    mock = new MockTb3(); await mock.start(PORT);
    mock.setPosition(0, 0);
    dev = makeDevice(); dev.start();
    await waitFor(() => dev!.getState().connected);
    await dev.gotoAngle(15, 0);
    expect(mock.lastGoto).toEqual({ pan_deg: 15, tilt_deg: 0, speed_dps: undefined });
    const final = await dev.waitForArrival(15 * 444.444, 0, 8000);
    expect(final.panSteps).toBeCloseTo(15 * 444.444, -1);
  });

  it("gotoAngle throws 409 message while a program is engaged", async () => {
    mock = new MockTb3(); await mock.start(PORT);
    mock.setProgramEngaged(true);
    dev = makeDevice(); dev.start();
    await waitFor(() => dev!.getState().connected);
    await expect(dev.gotoAngle(1, 0)).rejects.toThrow(/program engaged/);
  });

  it("setHome zeroes and stop/camera/program reach the device", async () => {
    mock = new MockTb3(); await mock.start(PORT);
    mock.setPosition(9999, 8888);
    dev = makeDevice(); dev.start();
    await waitFor(() => dev!.getState().connected);
    await dev.setHome();
    expect(mock.homeCount).toBe(1);
    await dev.stop();
    expect(mock.stopCount).toBe(1);
    await dev.triggerCamera("shoot", 200);
    expect(mock.lastCamera).toEqual({ action: "shoot", ms: 200 });
    await dev.selectProgram(3, true);
    expect(mock.lastProgram).toEqual({ type: 3, select: true });
    const progs = await dev.listPrograms();
    expect(progs.names.length).toBe(8);
  });

  it("jog streams a joystick frame then a zero frame", async () => {
    mock = new MockTb3(); await mock.start(PORT);
    dev = makeDevice(); dev.start();
    await waitFor(() => dev!.getState().connected);
    await dev.jog(50, 0, 0, 250);
    await waitFor(() => mock!.lastJog !== null && mock!.lastJog.x === 0);
    expect(mock.lastJog).toEqual({ x: 0, y: 0, aux: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tb3-mcp && npm test -- device`
Expected: FAIL — cannot resolve `../src/device.js`.

- [ ] **Step 3: Create `tb3-mcp/src/device.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tb3-mcp && npm test -- device`
Expected: PASS — all 5 Device cases green.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/device.ts tb3-mcp/test/device.test.ts
git commit -m "feat(mcp): TB3 device client (ws telemetry + http commands)"
```

---

### Task 5: MCP tools

**Files:**
- Create: `tb3-mcp/src/tools.ts`
- Test: `tb3-mcp/test/tools.test.ts`

**Interfaces:**
- Consumes: `Device` (device.ts), `Config` (config.ts), angle helpers (`stepsToDeg`, `degToSteps`, `applySign`, `checkPanTilt`, `checkSpeed`, `Limits`).
- Produces:
  - `registerTools(server: McpServer, device: Device, cfg: Config): void` — registers 8 tools: `get_status`, `goto_angle`, `jog`, `stop`, `set_home`, `trigger_camera`, `list_programs`, `select_program`.
  - Tool semantics:
    - Positions to/from the LLM are **user degrees** (device degrees × sign).
    - `goto_angle` validates limits (`checkPanTilt`) and speed (`checkSpeed`) → returns an error `content` (not a throw) when out of range; otherwise converts to device degrees, calls `device.gotoAngle`, computes a timeout, and awaits `device.waitForArrival`.
    - `jog` maps `pan_dps`/`tilt_dps` to joystick units via `cfg.maxJogDps`: `joy = clamp(round(dps / maxJogDps * 100), -100, 100)`.

- [ ] **Step 1: Write the failing test** — `tb3-mcp/test/tools.test.ts`

Uses the SDK's in-memory transport pair to drive real MCP tool calls against a `Device` wired to the mock.

```ts
import { describe, it, expect, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";
import { registerTools } from "../src/tools.js";

const PORT = 8793;
let mock: MockTb3 | null = null;
let dev: Device | null = null;

async function harness(env: Record<string, string> = {}) {
  mock = new MockTb3(); await mock.start(PORT);
  const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}`, ...env });
  dev = new Device(cfg); dev.start();
  const t0 = Date.now();
  while (!dev.getState().connected && Date.now() - t0 < 3000) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const server = new McpServer({ name: "tb3-mcp", version: "test" });
  registerTools(server, dev, cfg);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

afterEach(async () => {
  dev?.close(); dev = null;
  if (mock) { await mock.stop(); mock = null; }
});

function textOf(result: any): string {
  return result.content.map((c: any) => c.text).join("\n");
}

describe("MCP tools", () => {
  it("lists all 8 tools", async () => {
    const client = await harness();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_status", "goto_angle", "jog", "list_programs",
      "select_program", "set_home", "stop", "trigger_camera",
    ]);
  });

  it("get_status reports position in degrees", async () => {
    const client = await harness();
    mock!.setPosition(30 * 444.444, 0);
    await new Promise((r) => setTimeout(r, 200));
    const res = await client.callTool({ name: "get_status", arguments: {} });
    expect(textOf(res)).toMatch(/"pan_deg":\s*30/);
  });

  it("goto_angle moves and reports arrival", async () => {
    const client = await harness();
    mock!.setPosition(0, 0);
    const res = await client.callTool({ name: "goto_angle", arguments: { pan_deg: 20, tilt_deg: 0 } });
    expect(mock!.lastGoto!.pan_deg).toBeCloseTo(20, 5);
    expect(textOf(res)).toMatch(/arrived|pan_deg/i);
  });

  it("goto_angle refuses an out-of-limit target", async () => {
    const client = await harness();
    const res = await client.callTool({ name: "goto_angle", arguments: { pan_deg: 999, tilt_deg: 0 } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/outside the allowed range/);
    expect(mock!.lastGoto).toBeNull();
  });

  it("goto_angle applies pan_sign to reach device frame", async () => {
    const client = await harness({ TB3_PAN_SIGN: "-1" });
    mock!.setPosition(0, 0);
    await client.callTool({ name: "goto_angle", arguments: { pan_deg: 20, tilt_deg: 0 } });
    expect(mock!.lastGoto!.pan_deg).toBeCloseTo(-20, 5); // user +20 → device -20
  });

  it("jog maps dps to joystick units", async () => {
    const client = await harness(); // maxJogDps default 20
    await client.callTool({ name: "jog", arguments: { pan_dps: 20, tilt_dps: 0, duration_ms: 150 } });
    // full-scale: 20/20*100 = 100, then zeroed
    await new Promise((r) => setTimeout(r, 50));
    expect(mock!.lastJog).toEqual({ x: 0, y: 0, aux: 0 });
  });

  it("stop, set_home, trigger_camera, select_program reach the device", async () => {
    const client = await harness();
    await client.callTool({ name: "stop", arguments: {} });
    expect(mock!.stopCount).toBe(1);
    await client.callTool({ name: "set_home", arguments: {} });
    expect(mock!.homeCount).toBe(1);
    await client.callTool({ name: "trigger_camera", arguments: { action: "shoot", ms: 120 } });
    expect(mock!.lastCamera).toEqual({ action: "shoot", ms: 120 });
    await client.callTool({ name: "select_program", arguments: { index: 2, commit: true } });
    expect(mock!.lastProgram).toEqual({ type: 2, select: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tb3-mcp && npm test -- tools`
Expected: FAIL — cannot resolve `../src/tools.js`.

- [ ] **Step 3: Create `tb3-mcp/src/tools.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Device } from "./device.js";
import { Config } from "./config.js";
import { stepsToDeg, degToSteps, applySign, checkPanTilt, checkSpeed, Limits } from "./angles.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}
function errText(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function registerTools(server: McpServer, device: Device, cfg: Config): void {
  const limits: Limits = {
    panMin: cfg.panMin, panMax: cfg.panMax,
    tiltMin: cfg.tiltMin, tiltMax: cfg.tiltMax,
    maxSpeedDps: cfg.maxSpeedDps,
  };

  server.registerTool(
    "get_status",
    { description: "Read the TB3's current position (degrees), motion, battery, program, and connectivity.", inputSchema: {} },
    async () => {
      const s = device.getState();
      return text(JSON.stringify({
        connected: s.connected,
        pan_deg: Number(applySign(stepsToDeg(s.panSteps), cfg.panSign).toFixed(3)),
        tilt_deg: Number(applySign(stepsToDeg(s.tiltSteps), cfg.tiltSign).toFixed(3)),
        aux_steps: Math.round(s.auxSteps),
        moving: s.moving,
        program_engaged: s.programEngaged,
        battery_v: s.batteryV,
        sta_ip: s.staIp,
      }, null, 2));
    },
  );

  server.registerTool(
    "goto_angle",
    {
      description: "Move to an absolute pan/tilt angle in degrees (user frame). Blocks until arrival.",
      inputSchema: {
        pan_deg: z.number().describe("absolute pan angle in degrees"),
        tilt_deg: z.number().describe("absolute tilt angle in degrees"),
        speed_dps: z.number().positive().optional().describe("slew speed in degrees/second; omit for device max"),
      },
    },
    async ({ pan_deg, tilt_deg, speed_dps }) => {
      const lim = checkPanTilt(pan_deg, tilt_deg, limits);
      if (!lim.ok) return errText(lim.error!);
      const spd = checkSpeed(speed_dps, cfg.maxSpeedDps);
      if (!spd.ok) return errText(spd.error!);

      const devPan = applySign(pan_deg, cfg.panSign);
      const devTilt = applySign(tilt_deg, cfg.tiltSign);
      try {
        await device.gotoAngle(devPan, devTilt, speed_dps);
      } catch (e) {
        return errText(`device rejected goto: ${(e as Error).message}`);
      }

      const cur = device.getState();
      const distDeg = Math.max(
        Math.abs(devPan - stepsToDeg(cur.panSteps)),
        Math.abs(devTilt - stepsToDeg(cur.tiltSteps)),
      );
      const effSpeed = speed_dps ?? cfg.maxSpeedDps;
      const timeoutMs = Math.max(5000, (distDeg / effSpeed) * 1000 * 3 + 3000);

      try {
        const final = await device.waitForArrival(degToSteps(devPan), degToSteps(devTilt), timeoutMs);
        return text(JSON.stringify({
          arrived: true,
          pan_deg: Number(applySign(stepsToDeg(final.panSteps), cfg.panSign).toFixed(3)),
          tilt_deg: Number(applySign(stepsToDeg(final.tiltSteps), cfg.tiltSign).toFixed(3)),
        }));
      } catch (e) {
        return errText((e as Error).message);
      }
    },
  );

  server.registerTool(
    "jog",
    {
      description: "Nudge the rig at a rate for a fixed duration (manual framing). Rate is approximate.",
      inputSchema: {
        pan_dps: z.number().describe("pan rate in degrees/second (approx)"),
        tilt_dps: z.number().describe("tilt rate in degrees/second (approx)"),
        aux: z.number().optional().describe("aux axis rate, -100..100 joystick units"),
        duration_ms: z.number().int().positive().max(30000).describe("how long to jog, milliseconds"),
      },
    },
    async ({ pan_dps, tilt_dps, aux, duration_ms }) => {
      const x = clamp(Math.round((pan_dps / cfg.maxJogDps) * 100 * cfg.panSign), -100, 100);
      const y = clamp(Math.round((tilt_dps / cfg.maxJogDps) * 100 * cfg.tiltSign), -100, 100);
      const a = clamp(Math.round((aux ?? 0) * cfg.auxSign), -100, 100);
      await device.jog(x, y, a, duration_ms);
      return text(`jogged for ${duration_ms}ms (joy x=${x} y=${y} aux=${a})`);
    },
  );

  server.registerTool(
    "stop",
    { description: "Immediately stop all motion.", inputSchema: {} },
    async () => { await device.stop(); return text("stopped"); },
  );

  server.registerTool(
    "set_home",
    { description: "Zero the current position as the new software home.", inputSchema: {} },
    async () => {
      try { await device.setHome(); return text("home set to current position"); }
      catch (e) { return errText(`device rejected set_home: ${(e as Error).message}`); }
    },
  );

  server.registerTool(
    "trigger_camera",
    {
      description: "Fire the camera shutter or focus for a duration.",
      inputSchema: {
        action: z.enum(["shoot", "focus"]),
        ms: z.number().int().positive().max(30000).default(150),
      },
    },
    async ({ action, ms }) => { await device.triggerCamera(action, ms); return text(`camera ${action} for ${ms}ms`); },
  );

  server.registerTool(
    "list_programs",
    { description: "List the 8 built-in programs and which is current.", inputSchema: {} },
    async () => text(JSON.stringify(await device.listPrograms(), null, 2)),
  );

  server.registerTool(
    "select_program",
    {
      description: "Select a built-in program (0..7). commit=true enters it (virtual C-press).",
      inputSchema: {
        index: z.number().int().min(0).max(7),
        commit: z.boolean().default(false),
      },
    },
    async ({ index, commit }) => {
      try { await device.selectProgram(index, commit); return text(`selected program ${index}${commit ? " (entered)" : ""}`); }
      catch (e) { return errText(`device rejected select_program: ${(e as Error).message}`); }
    },
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tb3-mcp && npm test -- tools`
Expected: PASS — all 7 tool cases green.

- [ ] **Step 5: Run the full suite**

Run: `cd tb3-mcp && npm test`
Expected: PASS — angles, config, mock-tb3, device, tools all green.

- [ ] **Step 6: Commit**

```bash
git add tb3-mcp/src/tools.ts tb3-mcp/test/tools.test.ts
git commit -m "feat(mcp): register 8 MCP control tools"
```

---

### Task 6: Server entrypoint + streamable HTTP + deploy + README

**Files:**
- Create: `tb3-mcp/src/server.ts`
- Create: `tb3-mcp/deploy/tb3-mcp.plist`, `tb3-mcp/deploy/tb3-mcp.service`, `tb3-mcp/README.md`
- Test: `tb3-mcp/test/server.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `Device`, `registerTools`, `McpServer`, `StreamableHTTPServerTransport`.
- Produces:
  - `buildApp(device: Device, cfg: Config): import("express").Express` — an Express app exposing `POST/GET/DELETE /mcp` with stateful streamable-HTTP sessions and optional bearer-token auth.
  - `main(): Promise<void>` — loads config, starts the device client, builds the app, and listens on `cfg.mcpPort`. Runs when the module is the entrypoint.

- [ ] **Step 1: Write the failing test** — `tb3-mcp/test/server.test.ts`

Boots the Express app against the mock and performs a real MCP initialize + `get_status` over HTTP using the SDK's HTTP client transport.

```ts
import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/server.js";

const DEV_PORT = 8794;
const MCP_PORT = 8795;
let mock: MockTb3 | null = null;
let dev: Device | null = null;
let httpServer: Server | null = null;

afterEach(async () => {
  await new Promise<void>((r) => (httpServer ? httpServer.close(() => r()) : r())); httpServer = null;
  dev?.close(); dev = null;
  if (mock) { await mock.stop(); mock = null; }
});

describe("server", () => {
  it("serves MCP over streamable HTTP and returns tool results", async () => {
    mock = new MockTb3(); await mock.start(DEV_PORT);
    mock.setPosition(45 * 444.444, 0);
    const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${DEV_PORT}`, TB3_MCP_PORT: String(MCP_PORT) });
    dev = new Device(cfg); dev.start();
    await new Promise((r) => setTimeout(r, 300));

    const app = buildApp(dev, cfg);
    await new Promise<void>((r) => { httpServer = app.listen(MCP_PORT, r); });

    const client = new Client({ name: "http-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`));
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.length).toBe(8);

    const res: any = await client.callTool({ name: "get_status", arguments: {} });
    expect(res.content[0].text).toMatch(/"pan_deg":\s*45/);

    await transport.close();
  });

  it("rejects requests without a token when a token is configured", async () => {
    mock = new MockTb3(); await mock.start(DEV_PORT);
    const cfg = loadConfig(undefined, {
      TB3_DEVICE_HOST: `127.0.0.1:${DEV_PORT}`, TB3_MCP_PORT: String(MCP_PORT), TB3_MCP_TOKEN: "sekret",
    });
    dev = new Device(cfg); dev.start();
    await new Promise((r) => setTimeout(r, 200));
    const app = buildApp(dev, cfg);
    await new Promise<void>((r) => { httpServer = app.listen(MCP_PORT, r); });

    const r = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(r.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tb3-mcp && npm test -- server`
Expected: FAIL — cannot resolve `../src/server.js`.

- [ ] **Step 3: Create `tb3-mcp/src/server.ts`**

```ts
import express, { type Express, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, type Config } from "./config.js";
import { Device } from "./device.js";
import { registerTools } from "./tools.js";

export function buildApp(device: Device, cfg: Config): Express {
  const app = express();
  app.use(express.json());

  // Optional bearer-token gate.
  app.use("/mcp", (req: Request, res: Response, next) => {
    if (!cfg.mcpToken) return next();
    const auth = req.header("authorization") ?? "";
    if (auth === `Bearer ${cfg.mcpToken}`) return next();
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null });
  });

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post("/mcp", async (req: Request, res: Response) => {
    const sid = req.header("mcp-session-id");
    let transport: StreamableHTTPServerTransport | undefined = sid ? transports[sid] : undefined;

    if (!transport && !sid && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports[id] = transport!; },
      });
      transport.onclose = () => { if (transport!.sessionId) delete transports[transport!.sessionId]; };
      const server = new McpServer({ name: "tb3-mcp", version: "0.1.0" });
      registerTools(server, device, cfg);
      await server.connect(transport);
    }

    if (!transport) {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "no valid session" }, id: null });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  });

  const sessionStream = async (req: Request, res: Response) => {
    const sid = req.header("mcp-session-id");
    const transport = sid ? transports[sid] : undefined;
    if (!transport) { res.status(400).send("no valid session"); return; }
    await transport.handleRequest(req, res);
  };
  app.get("/mcp", sessionStream);
  app.delete("/mcp", sessionStream);

  return app;
}

export async function main(): Promise<void> {
  const cfg = loadConfig(process.env.TB3_CONFIG ?? "config.json");
  const device = new Device(cfg);
  device.start();
  const app = buildApp(device, cfg);
  app.listen(cfg.mcpPort, () => {
    console.log(`[tb3-mcp] MCP streamable HTTP on :${cfg.mcpPort}/mcp → device ${cfg.deviceHost}` +
      (cfg.mcpToken ? " (token required)" : ""));
    console.log(`[tb3-mcp] limits pan[${cfg.panMin},${cfg.panMax}] tilt[${cfg.tiltMin},${cfg.tiltMax}] maxSpeed ${cfg.maxSpeedDps}°/s`);
  });
}

const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) { main().catch((e) => { console.error(e); process.exit(1); }); }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tb3-mcp && npm test -- server`
Expected: PASS — both server cases green.

- [ ] **Step 5: Verify the build compiles**

Run: `cd tb3-mcp && npm run build`
Expected: `tsc` exits 0; `dist/server.js` exists.

- [ ] **Step 6: Create deploy files and README**

`tb3-mcp/deploy/tb3-mcp.plist` (macOS launchd — edit paths for your machine):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.tb3.mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>node</string>
    <string>/ABSOLUTE/PATH/TO/TB3-ESP32/tb3-mcp/dist/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>/ABSOLUTE/PATH/TO/TB3-ESP32/tb3-mcp</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/tb3-mcp.log</string>
  <key>StandardErrorPath</key><string>/tmp/tb3-mcp.err</string>
</dict>
</plist>
```

`tb3-mcp/deploy/tb3-mcp.service` (systemd — edit paths/user):
```ini
[Unit]
Description=TB3 MCP control daemon
After=network-online.target

[Service]
WorkingDirectory=/opt/tb3-mcp
ExecStart=/usr/bin/node /opt/tb3-mcp/dist/server.js
Restart=always
RestartSec=3
Environment=TB3_DEVICE_HOST=tb3.local

[Install]
WantedBy=multi-user.target
```

`tb3-mcp/README.md`:
```markdown
# tb3-mcp

Always-on MCP daemon that lets any LLM control the eMotimo TB3 over the network.

## Run

```bash
cd tb3-mcp
npm install
cp config.example.json config.json   # edit deviceHost + limits for your rig
npm run build
npm start                             # serves MCP at http://<host>:8770/mcp
```

Dev mode (no build): `npm run dev`. Tests: `npm test`.

## Configuration

`config.json` (all keys overridable by env, e.g. `TB3_DEVICE_HOST`, `TB3_MCP_PORT`,
`TB3_MCP_TOKEN`, `TB3_MAX_SPEED_DPS`, `TB3_PAN_SIGN`):

| key | default | meaning |
|---|---|---|
| deviceHost | `tb3.local` | TB3 host or `ip:port` |
| mcpPort | `8770` | MCP HTTP/SSE listen port |
| mcpToken | (unset) | if set, clients must send `Authorization: Bearer <token>` |
| panMin/panMax | `-180/180` | pan soft limits (degrees) |
| tiltMin/tiltMax | `-90/90` | tilt soft limits (degrees) |
| maxSpeedDps | `30` | max goto speed (°/s) |
| maxJogDps | `20` | °/s that maps to full joystick deflection |
| panSign/tiltSign/auxSign | `1` | per-axis sign flip (`1` or `-1`) |

**Soft limits refuse out-of-range moves** — there are no endstops. Set them to your rig's real reachable range.

## Tools

`get_status`, `goto_angle`, `jog`, `stop`, `set_home`, `trigger_camera`, `list_programs`, `select_program`.

## Connect a client

Point any MCP client at `http://<host>:8770/mcp` (streamable HTTP). Example Claude Desktop
config entry:

```json
{ "mcpServers": { "tb3": { "url": "http://localhost:8770/mcp" } } }
```

## Always-on

- macOS: edit paths in `deploy/tb3-mcp.plist`, then `launchctl load -w ~/Library/LaunchAgents/tb3-mcp.plist`.
- Linux/Pi: edit `deploy/tb3-mcp.service`, then `systemctl enable --now tb3-mcp`.
```

- [ ] **Step 7: Commit**

```bash
git add tb3-mcp/src/server.ts tb3-mcp/test/server.test.ts tb3-mcp/deploy tb3-mcp/README.md
git commit -m "feat(mcp): streamable-HTTP server entrypoint + deploy + docs"
```

---

### Task 7: Firmware `POST /api/home`

**Files:**
- Modify: `src/tb3_web.h` (add glue prototypes)
- Modify: `src/TB3_WebGlue.ino` (add `tb3_goto_safe`, `tb3_set_home`)
- Modify: `src/tb3_web.cpp` (add `s_home_request` state, `/api/home` route, drain in `tb3_web_poll`)

**Interfaces:**
- Consumes: `set_position(float,float,float)` (`src/TB3_Stepper.ino:234`), `Program_Engaged`, `motorMoving`, `sendJson`, `tb3_web_poll`.
- Produces:
  - `bool tb3_goto_safe();` — `!Program_Engaged && motorMoving == 0`.
  - `void tb3_set_home();` — `set_position(0,0,0)`.

- [ ] **Step 1: Add glue prototypes to `src/tb3_web.h`**

Find the OTA gate prototype block (the `tb3_ota_safe_to_flash` group) and add below it:

```cpp
// --- goto / home glue (drained on loopTask by tb3_web_poll) ---
bool tb3_goto_safe();     // !Program_Engaged && motorMoving == 0
void tb3_set_home();      // set_position(0,0,0)
```

- [ ] **Step 2: Add glue definitions to `src/TB3_WebGlue.ino`**

Append after the existing OTA glue block (`tb3_ota_resume`):

```cpp
// ---- goto / home ----------------------------------------------------------
bool tb3_goto_safe()
{
  return !Program_Engaged && motorMoving == 0;
}

void tb3_set_home()
{
  set_position(0.0, 0.0, 0.0);   // zero the software origin; no motion
}
```

- [ ] **Step 3: Add pending-state + route + drain to `src/tb3_web.cpp`**

Near the other `static volatile` request flags (e.g. next to `s_stop_request`), add:
```cpp
static volatile bool s_home_request = false;
```

In `setupRoutes()`, after the `/api/stop` handler, add:
```cpp
  s_server.on("/api/home", HTTP_POST, [](AsyncWebServerRequest *req) {
    if (!tb3_goto_safe()) { sendJson(req, 409, "{\"error\":\"busy\"}"); return; }
    s_home_request = true;
    sendJson(req, 202, "{\"ok\":true}");
  });
```

In `tb3_web_poll()`, next to the `s_stop_request` drain, add:
```cpp
  if (s_home_request) {
    s_home_request = false;
    tb3_set_home();
  }
```

- [ ] **Step 4: Build the firmware**

Run: `pio run -e esp32-s3-devkitc-1`
Expected: `SUCCESS`.

- [ ] **Step 5: Commit**

```bash
git add src/tb3_web.h src/TB3_WebGlue.ino src/tb3_web.cpp
git commit -m "feat(fw): POST /api/home zeroes the software origin"
```

- [ ] **Step 6: Hardware verification (human, after OTA/flash)**

Deploy, then `curl -X POST http://<device-ip>/api/home` and confirm `/api/status` reports `pos.pan≈0, pos.tilt≈0`. Confirm it returns `409` while a program is engaged.

---

### Task 8: Firmware `POST /api/goto`

**Files:**
- Modify: `src/tb3_web.h` (add glue prototypes)
- Modify: `src/TB3_WebGlue.ino` (add `tb3_goto_execute`)
- Modify: `src/tb3_web.cpp` (add goto pending-state, `tb3_web_pump_during_move`, `/api/goto` route, drain)

**Interfaces:**
- Consumes: `synched3PtMove_max(float,float,float)` (`src/TB_DF.ino:1474`), `synched3AxisMove_timed(float,float,float,float,float)` (`src/TB_DF.ino:1554`), `startISR1/stopISR1` (`src/TB3_IO_ISR.ino`), `updateMotorVelocities()`, `enable_PT/enable_AUX`, `nextMoveLoaded`, `motorMoving`, `current_steps`, `STEPS_PER_DEG`, `tb3_request_stop()`, `s_stop_request`.
- Produces:
  - `void tb3_goto_execute(float pan_deg, float tilt_deg, float speed_dps);` — absolute coordinated move (speed_dps ≤ 0 ⇒ max speed), stop-interruptible.
  - `void tb3_web_pump_during_move();` — drains `s_stop_request` only (declared in `tb3_web.h`, defined in `tb3_web.cpp`).

**Design note (why blocking + a minimal pump):** The firmware has no pattern for pumping the full input path inside a `while(motorMoving)` loop; the comms-alive program pattern is a non-blocking state machine. Rather than restructure the state machine, `tb3_goto_execute` runs the standard blocking move loop but calls `tb3_web_pump_during_move()` each iteration, which drains only `s_stop_request → tb3_request_stop() → hardStopRequested`, so `/api/stop` still interrupts the move. The LCD/menu freezes for the (usually brief) duration of a discrete move — acceptable, and outbound telemetry keeps flowing from the separate core-0 task. `s_goto_request` is cleared before executing, so the re-entrant `tb3_web_pump_during_move()` never re-triggers the goto.

- [ ] **Step 1: Add glue prototypes to `src/tb3_web.h`**

Below the `tb3_set_home();` line from Task 7:
```cpp
void tb3_goto_execute(float pan_deg, float tilt_deg, float speed_dps); // absolute move, stop-interruptible
void tb3_web_pump_during_move();  // drains a pending /api/stop during a blocking move
```

- [ ] **Step 2: Add `tb3_web_pump_during_move` to `src/tb3_web.cpp`**

Add this free function above `tb3_web_poll()` (it needs `s_stop_request` and `tb3_request_stop`, both already in this file):
```cpp
// Called from tb3_goto_execute()'s blocking move loop so /api/stop still lands.
void tb3_web_pump_during_move() {
  if (s_stop_request) {
    s_stop_request = false;
    tb3_request_stop();   // sets hardStopRequested; updateMotorVelocities() decelerates
  }
}
```

- [ ] **Step 3: Add the goto glue to `src/TB3_WebGlue.ino`**

Append after `tb3_set_home()`:
```cpp
void tb3_goto_execute(float pan_deg, float tilt_deg, float speed_dps)
{
  float tx = pan_deg * STEPS_PER_DEG;
  float ty = tilt_deg * STEPS_PER_DEG;
  float tz = current_steps.z;              // goto controls pan/tilt; hold aux

  enable_PT();
  enable_AUX();

  if (speed_dps > 0.0) {
    float dist_deg = max(fabs(pan_deg  - current_steps.x / STEPS_PER_DEG),
                         fabs(tilt_deg - current_steps.y / STEPS_PER_DEG));
    float move_time = dist_deg / speed_dps;          // seconds
    if (move_time < 0.05) synched3PtMove_max(tx, ty, tz);
    else                  synched3AxisMove_timed(tx, ty, tz, move_time, 0.2);
  } else {
    synched3PtMove_max(tx, ty, tz);
  }

  startISR1();
  do {
    if (!nextMoveLoaded) updateMotorVelocities();
    tb3_web_pump_during_move();            // lets /api/stop break us out
  } while (motorMoving);
  stopISR1();
}
```

- [ ] **Step 4: Add goto pending-state + route + drain to `src/tb3_web.cpp`**

Near `s_home_request`, add:
```cpp
static volatile bool  s_goto_request = false;
static volatile float s_goto_pan_deg = 0, s_goto_tilt_deg = 0, s_goto_speed_dps = 0;
```

In `setupRoutes()`, after the `/api/home` handler, add the JSON route:
```cpp
  s_server.addHandler(new AsyncCallbackJsonWebHandler("/api/goto",
    [](AsyncWebServerRequest *req, JsonVariant &json) {
      JsonVariantConst d = json.as<JsonVariantConst>();
      float pan  = d["pan_deg"]  | (float)NAN;
      float tilt = d["tilt_deg"] | (float)NAN;
      float spd  = d["speed_dps"] | 0.0f;      // 0 => device max
      if (!(isfinite(pan) && isfinite(tilt) && fabs(pan) < 100000 && fabs(tilt) < 100000)) {
        sendJson(req, 400, "{\"error\":\"pan_deg/tilt_deg required and finite\"}");
        return;
      }
      if (!tb3_goto_safe()) {
        sendJson(req, 409, "{\"error\":\"busy - program engaged\"}");
        return;
      }
      s_goto_pan_deg = pan; s_goto_tilt_deg = tilt; s_goto_speed_dps = spd;
      s_goto_request = true;
      sendJson(req, 202, "{\"ok\":true}");
    }));
```

In `tb3_web_poll()`, after the `s_home_request` drain, add:
```cpp
  if (s_goto_request) {
    s_goto_request = false;
    tb3_goto_execute(s_goto_pan_deg, s_goto_tilt_deg, s_goto_speed_dps);
  }
```

- [ ] **Step 5: Build the firmware**

Run: `pio run -e esp32-s3-devkitc-1`
Expected: `SUCCESS`. (If `isfinite`/`NAN` are unresolved, add `#include <math.h>` at the top of `tb3_web.cpp`.)

- [ ] **Step 6: Run the daemon suite against the unchanged mock (regression sanity)**

Run: `cd tb3-mcp && npm test`
Expected: PASS — the firmware change does not touch the daemon; the mock already mirrors `/api/goto`, so this confirms the contract is stable.

- [ ] **Step 7: Commit**

```bash
git add src/tb3_web.h src/TB3_WebGlue.ino src/tb3_web.cpp
git commit -m "feat(fw): POST /api/goto absolute pan/tilt move (stop-interruptible)"
```

- [ ] **Step 8: Hardware verification (human, after OTA/flash)**

1. `curl -X POST http://<ip>/api/goto -H 'content-type: application/json' -d '{"pan_deg":10,"tilt_deg":0}'` → `202`; the rig slews and `/api/status` settles near `pan≈10*444.444` steps.
2. Repeat with `"speed_dps":3` and confirm the move is visibly slower.
3. Start a program, then attempt a goto → expect `409` and no motion.
4. During a slow goto, `curl -X POST http://<ip>/api/stop` → the move halts promptly.
5. End to end: point an MCP client at the daemon and call `goto_angle` / `set_home` / `get_status`.

---

## Verification (whole plan)

- **Daemon:** `cd tb3-mcp && npm test` → all suites green; `npm run build` → clean.
- **Firmware:** `pio run -e esp32-s3-devkitc-1` → `SUCCESS`.
- **Hardware (human):** Tasks 7 & 8 verification steps, deployed via the OTA path from `feat/ota-lcd-ui`.
