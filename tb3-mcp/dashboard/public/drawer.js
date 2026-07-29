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
//
// Three seams exist for the guided-procedure tasks that build on this shell
// (calibration is the first: see setEntryRenderer/updateStrip/refresh below):
//
//   setEntryRenderer(entryId, renderFn) -- gives an entry a real body
//     (instead of the placeholder) without editing this file.
//   updateStrip(fields) -- updates a live readout (e.g. a trim-offset
//     readout while aiming) inside an ALREADY-collapsed strip without
//     rewriting the strip's innerHTML, so any buttons collapseToStrip put
//     there (and their listeners) survive untouched across a tick that only
//     changes a number.
//   refresh() -- re-renders the currently-open entry in place, without
//     changing mode. A registered renderer is deliberately called fresh
//     every time _renderBody() runs rather than cached (see
//     setEntryRenderer's own doc) -- but _renderBody() only runs from
//     open()/expand()/a nav click, none of which an SSE tick landing while
//     the drawer is already open triggers on its own. Without refresh(), a
//     calibration procedure left open across a tick would freeze its step
//     list at whatever state it had when the drawer was first opened,
//     silently showing stale prerequisites -- exactly the defect this whole
//     redesign exists to fix. See app.js's render(), which calls this once
//     per tick whenever mode() is "open". _renderBody() itself only writes
//     to the DOM when the rendered string actually changed (see its own
//     doc) -- refresh() at tick rate must not mean a DOM rewrite at tick
//     rate, or every mid-tick click/scroll position/keyboard focus inside
//     the drawer becomes collateral damage of a render that changed
//     nothing.

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// The drawer's navigable entries. "calibration" now has a real body --
// app.js registers procedures.js's renderCalibration via setEntryRenderer at
// startup, and the standalone #calibration section index.html used to carry
// (back when this drawer had no wiring yet) has been removed. An entry with
// no registered renderer (setEntryRenderer) falls back to a plain
// placeholder -- see defaultContentHtml below -- so the shell stays
// navigable even before the task that owns a given procedure has wired one
// up.
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

// Same guard as forEachMatch, for a single-node querySelector lookup.
function queryOne(root, selector) {
  if (!root || typeof root.querySelector !== "function") return null;
  return root.querySelector(selector);
}

// The stub body shown for an entry with no registered renderer (see
// setEntryRenderer) -- every entry except calibration, today.
function defaultContentHtml() {
  return `<p class="drawer-placeholder muted">Not implemented yet.</p>`;
}

// Body markup for one entry: a nav strip across every entry (so the whole
// drawer is navigable, not just the one that was opened) plus `contentHtml`
// -- the active entry's real content, already rendered by the caller (see
// Drawer._renderBody). Pure/module-level: takes exactly what it needs to
// draw, no instance state.
function renderBody(activeId, contentHtml) {
  const nav = ENTRIES.map((entry) => {
    const active = entry.id === activeId ? " drawer-nav-active" : "";
    return `<button type="button" class="drawer-nav-item${active}" data-entry="${entry.id}">${escapeHtml(entry.label)}</button>`;
  }).join("");

  const entry = ENTRIES.find((e) => e.id === activeId) ?? ENTRIES[0];

  return `
    <div class="drawer-head">
      <h2>Setup</h2>
      <button type="button" class="drawer-close" data-action="close" aria-label="close setup drawer">&times;</button>
    </div>
    <nav class="drawer-nav">${nav}</nav>
    <div class="drawer-content">
      <h3>${escapeHtml(entry.label)}</h3>
      ${contentHtml}
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
    // entryId -> () => htmlString, registered via setEntryRenderer. Empty
    // until a later task's procedure module registers one; an entry with no
    // renderer here gets defaultContentHtml's placeholder instead.
    this._renderers = new Map();

    // The exact HTML string last WRITTEN to body.innerHTML (not merely last
    // computed) -- see _renderBody()'s doc for why this exists (review
    // fix, UI-8 round 1, finding I-1). null means "nothing written since
    // the DOM was last known-blank" (constructor, close()), so the very
    // next _renderBody() always writes rather than comparing against a
    // stale value that no longer matches what's actually in the DOM.
    this._lastBodyHtml = null;

    // Match the "closed" mode this._mode starts in explicitly, rather than
    // trusting index.html to already carry `hidden` on #drawer/#proc-strip
    // (true today, but this constructor shouldn't depend on the markup
    // agreeing with it by coincidence).
    this.els.drawer.hidden = true;
    this.els.body.innerHTML = "";
    this.els.strip.hidden = true;
    this.els.strip.innerHTML = "";
  }

  mode() {
    return this._mode;
  }

  // Registers `renderFn` (called with no args, returning an HTML string) as
  // the real body for `entryId`, replacing the placeholder for that entry
  // from the next render onward (open()/expand()/a nav click landing on it).
  // Called fresh on every render rather than once -- a guided procedure's
  // body generally depends on live daemon state (step-gate.js's calibration
  // steps, an in-progress sighting, etc.), not a static string computed once
  // at registration time.
  //
  // Like collapseToStrip's `html` below, whatever `renderFn` returns is
  // inserted UNESCAPED (innerHTML) -- a renderer that embeds dynamic text
  // (an aircraft callsign, a free-text error message) must escape it itself.
  setEntryRenderer(entryId, renderFn) {
    this._renderers.set(entryId, renderFn);
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
    // The DOM was just blanked directly (not via _renderBody()) -- without
    // this, the next open() could compute the SAME html this entry had
    // before close() and wrongly skip the write, leaving the DOM stuck on
    // the "" close() just set. See _renderBody()'s doc.
    this._lastBodyHtml = null;
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
  // two action buttons), inserted UNESCAPED (innerHTML) -- a caller
  // embedding dynamic text (an aircraft callsign, a live measurement) must
  // escape it itself. Two conventions this markup can use, both optional:
  //   - `id="foo"` on a button/control, paired with a `handlers.foo`
  //     callback (see `handlers` below) -- wired to a click listener once,
  //     here.
  //   - `data-region="bar"` on any element whose TEXT changes over time
  //     (e.g. a live trim-offset readout) -- later updated via
  //     updateStrip({bar: "..."}) WITHOUT calling collapseToStrip again, so
  //     a per-tick readout update never tears down/rebuilds the buttons
  //     above (and their listeners) the way re-collapsing on every tick
  //     would.
  //
  // `handlers` is an optional { elementId: onClick } map matched against
  // this markup by id, e.g. { "strip-mark": () => ... }.
  collapseToStrip(html, handlers) {
    this._mode = "strip";
    this.els.drawer.hidden = true;
    this.els.strip.innerHTML = String(html ?? "");
    this.els.strip.hidden = false;
    // #drawer-body isn't touched while collapsed (its content just sits
    // hidden behind #drawer), but the cache is invalidated anyway so the
    // expand() that eventually follows always writes fresh content rather
    // than trusting that nothing relevant changed while the strip was up.
    this._lastBodyHtml = null;

    for (const [id, handler] of Object.entries(handlers || {})) {
      const target = queryOne(this.els.strip, "#" + id);
      if (target && typeof target.addEventListener === "function") {
        target.addEventListener("click", handler);
      }
    }
  }

  // Updates one or more `data-region="name"` elements inside the CURRENTLY
  // collapsed strip (see collapseToStrip's doc) by setting their
  // textContent -- never innerHTML, and never re-wiring anything -- so the
  // strip's buttons (and the listeners collapseToStrip attached to them)
  // are completely untouched. This is what lets an aiming step update a
  // live trim-offset readout every tick without the button-teardown/
  // flicker/lost-focus churn that calling collapseToStrip() per tick would
  // cause.
  //
  // `fields` is a { name: text } map; a name with no matching
  // `data-region="name"` element in the current strip markup is silently
  // skipped (most likely collapseToStrip was never called for this markup,
  // or the strip has since been cleared by close()/expand() -- either way,
  // there is nothing to update, not an error).
  updateStrip(fields) {
    for (const [name, text] of Object.entries(fields || {})) {
      const target = queryOne(this.els.strip, `[data-region="${name}"]`);
      if (target) target.textContent = String(text);
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

  // Re-renders the currently-open entry in place -- same entry, same mode --
  // so a caller (app.js, once per SSE tick) can push fresh daemon state into
  // an already-open drawer without the operator navigating away and back.
  // See this class's module doc for why this seam exists: setEntryRenderer's
  // renderer is only ever re-invoked from _renderBody(), and nothing before
  // this method called that on a tick landing mid-procedure.
  //
  // A no-op outside "open" mode: "closed" has nothing showing to refresh,
  // and "strip" is deliberately refreshed a different way (updateStrip's
  // named-region text patch, not a full re-render -- see its own doc on why
  // rebuilding the strip every tick would be wrong).
  refresh() {
    if (this._mode !== "open") return;
    this._renderBody();
  }

  // Review fix (UI-8 round 1, finding I-1): this used to write
  // body.innerHTML UNCONDITIONALLY on every call, including every call
  // refresh() makes -- once per SSE tick (~1s, src/dashboard/server.ts),
  // whether or not the rendered content actually changed. Three real
  // consequences of that: (1) a click whose mousedown/mouseup straddle a
  // tick loses its target the instant the tick lands, since the button it
  // pressed no longer exists -- the browser then dispatches `click` on
  // whatever ancestor is left, `closest("[data-act]")` finds nothing, and
  // the press silently does nothing; (2) #drawer has `overflow-y:auto`
  // (drawer.css) -- clobbering innerHTML resets scrollTop to 0 every
  // second, which is invisible today (six steps fit) but breaks the first
  // entry that doesn't; (3) keyboard focus inside the drawer is lost every
  // second. The renderer is still invoked on every call unconditionally --
  // that's what setEntryRenderer's "called fresh every render" contract
  // promises, and is a completely separate question from whether the DOM
  // gets touched. Only the DOM write (and the listener re-attachment that
  // depends on it) is now skipped when the freshly-rendered string is
  // byte-identical to what's already painted.
  _renderBody() {
    const entry = ENTRIES.find((e) => e.id === this._entryId) ?? ENTRIES[0];
    const renderer = this._renderers.get(entry.id);
    const contentHtml = renderer ? String(renderer() ?? "") : defaultContentHtml();
    const html = renderBody(this._entryId, contentHtml);
    if (html === this._lastBodyHtml) return; // nothing actually changed -- leave the DOM (and its scroll/focus/mid-press state) alone
    this._lastBodyHtml = html;
    this.els.body.innerHTML = html;

    forEachMatch(this.els.body, "[data-entry]", (node) => {
      node.addEventListener("click", () => this.open(node.dataset.entry));
    });
    forEachMatch(this.els.body, '[data-action="close"]', (node) => {
      node.addEventListener("click", () => this.close());
    });
  }
}
