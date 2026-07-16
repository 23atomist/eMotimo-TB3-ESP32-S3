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

  it("stop() before start() resolves promptly instead of hanging", async () => {
    const neverStarted = new MockTb3();
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("stop() did not resolve within 1s")), 1000);
    });
    await expect(Promise.race([neverStarted.stop(), timeout])).resolves.toBeUndefined();
  });

  it("start() on an already-bound port rejects, and the first mock still stops cleanly", async () => {
    const PORT2 = 8792;
    const first = new MockTb3();
    await first.start(PORT2);
    const second = new MockTb3();
    await expect(second.start(PORT2)).rejects.toThrow();
    await expect(second.stop()).resolves.toBeUndefined();
    await expect(first.stop()).resolves.toBeUndefined();
  });
});
