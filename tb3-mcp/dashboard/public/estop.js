// E-STOP: the single most safety-critical write this dashboard makes.
// Split out of app.js (2026-07-28 dashboard redesign, task 10 fix round 1)
// so this exact logic -- latch immediately on click, before any network
// round trip; clear only on an explicit operator action; always re-apply
// the motion gate and force an immediate cockpit re-render on either edge
// -- has a unit-testable home instead of living inline in a large bootstrap
// file. It is also the module a `scripts/` smoke test can exercise directly
// to guard against the exact regression this task's own history produced:
// a prior draft of the app.js split silently dropped the E-STOP button's
// click listener entirely, and no test or typecheck caught it -- only a
// real browser click did (see scripts/dashboard-smoke.mjs).
//
// Owns the ONE latch boolean the whole dashboard treats as ground truth for
// "can any control move the rig right now" -- every other module (jogHold/
// nudgeHold's isGated, the joystick's isGated/isSightGated, sector.js's drag
// gate, radar.js's click gate, procedure-actions.js's calibration/limits/
// home gates, cockpit.js's aimMode via render()) reads isLatched() rather
// than holding its own copy, so there is exactly one place this can ever be
// true.
//
// deps:
//   el                 -- needs el.estopBanner, el.estopBannerDetail.
//   toast               -- (message, ok) => void (app.js's own toast()).
//   applyMotionGate     -- () => void; re-applies the combined E-STOP/sun-
//     lock disabled state to every motion control not owned by cockpit.js.
//   refreshCockpitLock  -- () => void; forces an immediate cockpit
//     re-render with the just-changed latch folded in, so the AIM block
//     doesn't wait up to ~1s for the next SSE tick.
export function createEstop({ el, toast, applyMotionGate, refreshCockpitLock }) {
  let latched = false;

  function isLatched() {
    return latched;
  }

  // Latch immediately on click — this is a client-side safety latch, not a
  // reflection of confirmed server state, so it must not wait on the network.
  function latch() {
    latched = true;
    // Visibility is driven by the "show" class, not the [hidden] attribute:
    // an author-stylesheet `display` rule always beats the UA
    // [hidden]{display:none} rule, so relying on `hidden` here would leave
    // the banner stuck.
    el.estopBanner.classList.add("show");
    applyMotionGate();
    refreshCockpitLock();
  }

  function clear() {
    latched = false;
    el.estopBanner.classList.remove("show");
    el.estopBannerDetail.textContent = "";
    applyMotionGate();
    refreshCockpitLock();
  }

  function renderResult(result) {
    if (!result || typeof result !== "object") {
      el.estopBannerDetail.textContent = "no response from server";
      return;
    }
    const legs = ["firmware", "tracking", "agent"];
    const parts = legs.map((leg) => {
      const r = result[leg];
      if (!r) return `${leg}: —`;
      return `${leg}: ${r.ok ? "ok" : "FAIL"} (${r.message})`;
    });
    el.estopBannerDetail.textContent = parts.join(" · ");
    toast(result.allOk ? "E-STOP: all legs stopped" : "E-STOP: one or more legs failed", !!result.allOk);
  }

  // The #estop button's click handler: latches synchronously, then posts.
  async function trigger() {
    latch();
    try {
      const res = await fetch("/api/control/estop", { method: "POST" });
      const data = await res.json();
      renderResult(data);
    } catch (e) {
      el.estopBannerDetail.textContent =
        `request failed: ${e instanceof Error ? e.message : String(e)}`;
      toast("E-STOP request failed — remaining latched", false);
    }
  }

  return { isLatched, trigger, clear };
}
