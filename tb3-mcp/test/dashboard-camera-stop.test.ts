import { describe, it, expect, vi } from "vitest";
import { buildControlDeps } from "../src/dashboard/server.js";

// buildControlDeps takes the server's private `Sources` bundle. It isn't
// exported (only buildControlDeps is, for this test), so we borrow its shape
// via Parameters<> instead of duplicating/importing the interface.
type Sources = Parameters<typeof buildControlDeps>[0];

// buildControlDeps dereferences s.client.*/s.rig.*/s.sc.* immediately (most
// are .bind()'d at construction time), so every method it touches needs to
// exist as a real function even though cameraStop -- the only thing these
// tests exercise -- never calls them. None of these are asserted on.
function fakeSources(over: { mtx?: Sources["mtx"]; camera?: Sources["camera"] }): Sources {
  const asyncNoop = async (..._a: unknown[]): Promise<void> => {};
  const client = {
    track: asyncNoop,
    stopTracking: asyncNoop,
    jog: asyncNoop,
    setRigLocation: asyncNoop,
    sightLandmark: asyncNoop,
    solveCalibration: async () => "unused",
    clearCalibration: asyncNoop,
    getTrackSector: async () => ({ enabled: false, startDeg: 0, endDeg: 360 }),
    setTrackSector: asyncNoop,
    setSunGuard: asyncNoop,
  };
  const rig = { stop: asyncNoop };
  const sc = { stop: asyncNoop, start: asyncNoop };
  const camera = over.camera ?? { enable: () => {}, disable: () => {}, status: () => ({ enabled: false, streaming: false, viewers: 0 }) };
  return {
    client, rig, sc, camera,
    cfg: {} as Sources["cfg"],
    mtx: over.mtx ?? null,
  } as unknown as Sources;
}

describe("buildControlDeps().cameraStop", () => {
  it("closes the record valve before disabling the camera", () => {
    const order: string[] = [];
    const mtx = {
      setRecord: async (on: boolean) => {
        order.push(`setRecord:start:${on}`);
        await new Promise<void>((r) => setTimeout(r, 5)); // resolves LATER than disable()
        order.push(`setRecord:done:${on}`);
      },
    } as unknown as Sources["mtx"];
    const camera = {
      enable: () => {},
      disable: () => { order.push("disable"); },
      status: () => ({ enabled: false, streaming: false, viewers: 0 }),
    } as unknown as Sources["camera"];

    const deps = buildControlDeps(fakeSources({ mtx, camera }));
    deps.cameraStop();

    // setRecord is INVOKED (and runs synchronously up to its first await)
    // strictly before disable() -- the property under test -- even though
    // it doesn't finish until later.
    expect(order).toEqual(["setRecord:start:false", "disable"]);
  });

  it("never blocks Stop: a MediaMTX that never responds still lets disable() run", () => {
    const order: string[] = [];
    // A promise that never settles -- the worst case for a dead/unreachable
    // MediaMTX. cameraStop must not await this.
    const mtx = { setRecord: () => new Promise<void>(() => {}) } as unknown as Sources["mtx"];
    const camera = {
      enable: () => {},
      disable: () => { order.push("disable"); },
      status: () => ({ enabled: false, streaming: false, viewers: 0 }),
    } as unknown as Sources["camera"];

    const deps = buildControlDeps(fakeSources({ mtx, camera }));
    deps.cameraStop(); // must return synchronously, not hang

    expect(order).toEqual(["disable"]);
  });

  it("contains a setRecord rejection: no throw, no unhandled rejection, disable() still runs", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const order: string[] = [];
      const mtx = {
        setRecord: async () => { throw new Error("mediamtx unreachable"); },
      } as unknown as Sources["mtx"];
      const camera = {
        enable: () => {},
        disable: () => { order.push("disable"); },
        status: () => ({ enabled: false, streaming: false, viewers: 0 }),
      } as unknown as Sources["camera"];

      const deps = buildControlDeps(fakeSources({ mtx, camera }));
      expect(() => deps.cameraStop()).not.toThrow();
      expect(order).toEqual(["disable"]);

      // Let the rejected setRecord() promise settle and its .catch() run --
      // if cameraStop's fire-and-forget handling were missing, this is where
      // an unhandled rejection would surface.
      await new Promise((r) => setTimeout(r, 10));
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("mediamtx unreachable"));
    } finally {
      errSpy.mockRestore();
    }
  });

  it("MJPEG path (mtx: null) touches only camera.disable()", () => {
    const order: string[] = [];
    const camera = {
      enable: () => {},
      disable: () => { order.push("disable"); },
      status: () => ({ enabled: false, streaming: false, viewers: 0 }),
    } as unknown as Sources["camera"];

    const deps = buildControlDeps(fakeSources({ mtx: null, camera }));
    deps.cameraStop();

    expect(order).toEqual(["disable"]);
  });
});
