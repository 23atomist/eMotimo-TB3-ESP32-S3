// The Setup drawer: a state machine, not a mode switch.
//
// Multi-step procedures (calibration, teaching travel limits, setting home,
// the track sector, joystick setup) all live behind one "Setup" button so
// the always-visible cockpit doesn't get cluttered with controls an operator
// only touches occasionally. But half of calibration is AIMING -- watching
// the video, trimming until an aircraft centres -- and a drawer that hides
// the video while its own procedure asks the operator to look at the video
// would make that procedure impossible to perform. Hence three states
// instead of two:
//
//   closed -- cockpit only, drawer fully off-screen.
//   open   -- the drawer panel is visible, for configuration steps (typing
//             coordinates, running a sweep) that don't need eyes on the
//             video.
//   strip  -- the drawer BODY is hidden and a slim bar (#proc-strip) is
//             shown in its place instead, so the full cockpit -- including
//             the video -- stays visible underneath. This is what an aiming
//             step collapses to (collapseToStrip()); expand() reverses it
//             without losing the operator's place in the procedure.
//
// #drawer is a fixed-position overlay (see drawer.css) with a z-index BELOW
// #topbar's, so nothing this class does can ever cover the E-STOP button
// sitting in that sticky header -- see index.html/cockpit.css's comments on
// #topbar for the invariant this depends on.
//
// DOM elements are injected (constructor deps), not reached for via
// document/window, so this whole state machine can be pinned by vitest
// without a browser or jsdom -- same pattern as cockpit.js/camera-panel.js.
// See test/drawer.test.ts.

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// The drawer's navigable entries. Later tasks fill each one's real body
// (a guided procedure with its own step-gating, likely reusing step-gate.js
// the way calibration already does); this task only needs the entries to
// exist so the shell is testable and navigable, not to implement any of
// them. "calibration" deliberately matches the id later tasks will reuse
// when the standalone #calibration section (index.html) is finally migrated
// in here -- see this task's brief for why that migration is out of scope
// today.
const ENTRIES = [
  { id: "calibration", label: "Calibration" },
  { id: "travel-limits", label: "Travel limits" },
  { id: "set-home", label: "Set home" },
  { id: "track-sector", label: "Track sector" },
  { id: "joystick", label: "Joystick" },
];

// Runs `fn` for every element `root.querySelectorAll(selector)` matches, but
// only if `root` actually supports querySelectorAll -- the hand-rolled DOM
// fakes this class is tested against (test/drawer.test.ts's fakeEls) are
// plain objects with no query methods at all, and must not throw. On a real
// element this is a no-op guard; in production this always finds the nodes
// this class itself just wrote into innerHTML.
function forEachMatch(root, selector, fn) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  for (const node of root.querySelectorAll(selector)) fn(node);
}

// Placeholder body markup for one entry: a nav strip across every entry (so
// the whole drawer is navigable, not just the one that was opened) plus a
// stub content area for whichever entry is currently active. Later tasks
// replace the stub `<p>` with the entry's real guided procedure; the nav and
// the close button are this task's actual deliverable.
function renderBody(activeId) {
  const nav = ENTRIES.map((entry) => {
    const active = entry.id === activeId ? " drawer-nav-active" : "";
    return `<button type="button" class="drawer-nav-item${active}" data-entry="${entry.id}">${escapeHtml(entry.label)}</button>`;
  }).join("");

  const entry = ENTRIES.find((e) => e.id === activeId) ?? ENTRIES[0];
  // Calibration keeps its real form outside the drawer for now (see this
  // task's brief) -- say so explicitly rather than showing a bare "coming
  // soon" that would look like a bug next to a fully-working panel below it.
  const placeholder = entry.id === "calibration"
    ? "Still the standalone Calibration panel in the cockpit below -- not yet moved in here."
    : "Not implemented yet.";

  return `
    <div class="drawer-head">
      <h2>Setup</h2>
      <button type="button" class="drawer-close" data-action="close" aria-label="close setup drawer">&times;</button>
    </div>
    <nav class="drawer-nav">${nav}</nav>
    <div class="drawer-content">
      <h3>${escapeHtml(entry.label)}</h3>
      <p class="drawer-placeholder muted">${escapeHtml(placeholder)}</p>
    </div>
  `;
}

export class Drawer {
  // deps:
  //   drawer -- the outer panel (#drawer). Its `.hidden` is the one flag
  //             that decides whether the video can be covered: true in both
  //             "closed" and "strip", false only in "open".
  //   body   -- the panel's content container (#drawer-body). `.innerHTML`
  //             is rewritten on every open()/expand().
  //   strip  -- the slim always-cockpit-visible bar (#proc-strip). `.hidden`
  //             is true except while in "strip" mode.
  constructor({ drawer, body, strip }) {
    this.els = { drawer, body, strip };
    this._mode = "closed";
    // The entry last opened, remembered across a collapseToStrip()/expand()
    // round trip so expand() reopens the same procedure rather than
    // defaulting back to the first entry.
    this._entryId = ENTRIES[0].id;
  }

  mode() {
    return this._mode;
  }

  // Reveals the drawer panel showing `entryId` (falling back to the first
  // entry for an unknown id, rather than rendering a blank/broken panel).
  open(entryId) {
    this._entryId = ENTRIES.some((e) => e.id === entryId) ? entryId : ENTRIES[0].id;
    this._mode = "open";
    this.els.strip.hidden = true;
    this.els.strip.innerHTML = "";
    this.els.drawer.hidden = false;
    this._renderBody();
  }

  // Fully hides the drawer AND the strip -- cockpit-only, the resting state.
  close() {
    this._mode = "closed";
    this.els.drawer.hidden = true;
    this.els.body.innerHTML = "";
    this.els.strip.hidden = true;
    this.els.strip.innerHTML = "";
  }

  // Called by an in-progress procedure step that needs the operator's eyes
  // on the video (e.g. "trim until this aircraft is centred, then mark it").
  // Hides the ENTIRE drawer panel -- not just some inner region of it -- so
  // there is no state in which any part of #drawer can overlap the cockpit;
  // the slim #proc-strip (a normal-flow element above the cockpit grid, see
  // drawer.css) is shown in its place instead.
  //
  // `html` is the strip's content (typically a short status line plus one or
  // two action buttons); `handlers` is an optional { elementId: onClick }
  // map wired up against that markup by id, e.g. { "strip-mark": () => ... }.
  collapseToStrip(html, handlers) {
    this._mode = "strip";
    this.els.drawer.hidden = true;
    this.els.strip.innerHTML = String(html ?? "");
    this.els.strip.hidden = false;

    for (const [id, handler] of Object.entries(handlers || {})) {
      if (typeof this.els.strip.querySelector !== "function") continue;
      const target = this.els.strip.querySelector("#" + id);
      if (target && typeof target.addEventListener === "function") {
        target.addEventListener("click", handler);
      }
    }
  }

  // Reverses collapseToStrip(): brings the drawer panel back, showing
  // whichever entry was active when it collapsed (not necessarily the first
  // entry), and clears the strip.
  expand() {
    this._mode = "open";
    this.els.strip.hidden = true;
    this.els.strip.innerHTML = "";
    this.els.drawer.hidden = false;
    this._renderBody();
  }

  _renderBody() {
    this.els.body.innerHTML = renderBody(this._entryId);

    forEachMatch(this.els.body, "[data-entry]", (node) => {
      node.addEventListener("click", () => this.open(node.dataset.entry));
    });
    forEachMatch(this.els.body, '[data-action="close"]', (node) => {
      node.addEventListener("click", () => this.close());
    });
  }
}
