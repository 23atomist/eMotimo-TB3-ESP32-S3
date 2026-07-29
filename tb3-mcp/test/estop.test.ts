import { describe, it, expect, vi } from "vitest";
import { createEstop } from "../dashboard/public/estop.js";

// Hand-rolled fake DOM -- same convention as cockpit.test.ts/drawer.test.ts
// (no jsdom in this repo).
function fakeClassList() {
  const set = new Set<string>();
  return {
    add: (...cs: string[]) => { for (const c of cs) set.add(c); },
    remove: (...cs: string[]) => { for (const c of cs) set.delete(c); },
    has: (c: string) => set.has(c),
  };
}

function fakeEl() {
  return {
    estopBanner: { classList: fakeClassList() },
    estopBannerDetail: { textContent: "" },
  };
}

function setup(fetchImpl?: typeof fetch) {
  const el = fakeEl();
  const toasts: Array<[string, boolean]> = [];
  const toast = (message: string, ok: boolean) => { toasts.push([message, ok]); };
  const applyMotionGate = vi.fn();
  const refreshCockpitLock = vi.fn();
  if (fetchImpl) vi.stubGlobal("fetch", fetchImpl);
  const estop = createEstop({ el, toast, applyMotionGate, refreshCockpitLock });
  return { el, estop, toasts, applyMotionGate, refreshCockpitLock };
}

describe("createEstop", () => {
  it("starts unlatched", () => {
    const { estop } = setup();
    expect(estop.isLatched()).toBe(false);
  });

  // The safety property this whole module exists for: the latch must be
  // true THE INSTANT trigger() is called, before any network round trip --
  // not after the fetch resolves. A synchronous check right after calling
  // trigger() (not awaiting it) proves this.
  it("latches synchronously, before the network request resolves", () => {
    let resolveFetch!: (v: unknown) => void;
    const pending = new Promise((resolve) => { resolveFetch = resolve; });
    const { estop, el, applyMotionGate, refreshCockpitLock } = setup(
      (() => pending) as unknown as typeof fetch,
    );
    expect(estop.isLatched()).toBe(false);
    void estop.trigger(); // deliberately not awaited
    expect(estop.isLatched()).toBe(true);
    expect(el.estopBanner.classList.has("show")).toBe(true);
    expect(applyMotionGate).toHaveBeenCalledTimes(1);
    expect(refreshCockpitLock).toHaveBeenCalledTimes(1);
    resolveFetch({ json: async () => ({ allOk: true }) });
  });

  it("on a successful response, renders the per-leg detail and toasts success", async () => {
    const { estop, el, toasts } = setup((async () =>
      ({ json: async () => ({
        firmware: { ok: true, message: "stopped" },
        tracking: { ok: true, message: "stopped" },
        agent: { ok: true, message: "stopped" },
        allOk: true,
      }) })) as unknown as typeof fetch);
    await estop.trigger();
    expect(el.estopBannerDetail.textContent).toContain("firmware: ok (stopped)");
    expect(toasts).toContainEqual(["E-STOP: all legs stopped", true]);
  });

  it("reports a failed leg without claiming success", async () => {
    const { estop, el, toasts } = setup((async () =>
      ({ json: async () => ({
        firmware: { ok: false, message: "no response" },
        tracking: { ok: true, message: "stopped" },
        agent: { ok: true, message: "stopped" },
        allOk: false,
      }) })) as unknown as typeof fetch);
    await estop.trigger();
    expect(el.estopBannerDetail.textContent).toContain("firmware: FAIL (no response)");
    expect(toasts.some(([m, ok]) => !ok && /one or more legs failed/i.test(m))).toBe(true);
  });

  // The whole point of a client-side latch: even when the network request
  // itself throws, the rig is still treated as stopped -- it must NEVER
  // silently unlatch on a failed request.
  it("stays latched even when the request itself throws", async () => {
    const { estop, el, toasts } = setup((async () => { throw new Error("network down"); }) as unknown as typeof fetch);
    await estop.trigger();
    expect(estop.isLatched()).toBe(true);
    expect(el.estopBannerDetail.textContent).toMatch(/request failed/i);
    expect(toasts.some(([m, ok]) => !ok && /remaining latched/i.test(m))).toBe(true);
  });

  it("clear() unlatches, clears the banner class and detail text, and re-applies the gate", async () => {
    const { estop, el, applyMotionGate, refreshCockpitLock } = setup((async () =>
      ({ json: async () => ({ allOk: true }) })) as unknown as typeof fetch);
    await estop.trigger();
    expect(estop.isLatched()).toBe(true);

    estop.clear();
    expect(estop.isLatched()).toBe(false);
    expect(el.estopBanner.classList.has("show")).toBe(false);
    expect(el.estopBannerDetail.textContent).toBe("");
    // Once for trigger()'s latch, once for clear().
    expect(applyMotionGate).toHaveBeenCalledTimes(2);
    expect(refreshCockpitLock).toHaveBeenCalledTimes(2);
  });

  it("a malformed/non-object response is reported, not thrown", async () => {
    const { estop, el } = setup((async () => ({ json: async () => null })) as unknown as typeof fetch);
    await estop.trigger();
    expect(el.estopBannerDetail.textContent).toBe("no response from server");
  });
});
