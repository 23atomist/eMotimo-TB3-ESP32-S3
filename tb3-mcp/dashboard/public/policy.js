// Rule editor for the agent's target policy. The pure functions below are
// unit-tested (test/policy-ui.test.ts); the DOM wiring under them is not.
// That split exists because the tilt_dps ReferenceError (90a7ae6) shipped from
// an untested app.js path -- pure logic in a testable module is the cheap half
// of the defence.
//
// The evaluator (src/policy/rules.ts's evaluate()) is the single source of
// truth for which rule an aircraft matches -- this module never reimplements
// that matching logic. countMatches below counts using the daemon's own
// per-aircraft `ruleId` annotation (see AircraftRow.ruleId in src/dashboard/
// state.ts), so a live count on screen can never drift from what the
// evaluator that actually runs would produce. Matched on id, never on
// `rule` (the display name) -- two rules CAN share a name, and matching on
// name would silently report the union of both rules' counts under each.

export function newRule() {
  const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  // enabled:false (controller ruling on task-7-brief.md, overriding the
  // brief's original enabled:true): a rule with conditions:[] matches
  // EVERYTHING (evaluate()'s .every() over an empty array is vacuously true
  // -- deliberate, pinned by policy-rules.test.ts/policy-store.test.ts, and
  // never to be changed here). Paired with enabled:true, pressing "+ Add
  // rule" then Save would silently arm an enabled catch-all before the
  // operator has typed a single condition. Starting disabled costs one
  // extra click and removes that footgun.
  return { id, name: "New rule", enabled: false, canPreempt: false, conditions: [] };
}

export function validateRule(rule) {
  if (!rule.name || rule.name.trim() === "") return "Rule needs a name";
  for (const c of rule.conditions) {
    if (c.predicate) continue;
    if (c.op === "in") {
      if (!Array.isArray(c.values) || c.values.length === 0) return `${c.field}: pick at least one value`;
      continue;
    }
    if (typeof c.value !== "number" || !Number.isFinite(c.value)) return `${c.field}: needs a value`;
    if ((c.op === "within" || c.op === "not_within") &&
        (typeof c.value2 !== "number" || !Number.isFinite(c.value2))) {
      return `${c.field}: needs a second value`;
    }
  }
  return null;
}

// Immutable: returns a new array. A no-op at either edge rather than wrapping,
// because a rule silently jumping from top to bottom would change which rules
// preempt without the operator meaning it.
export function moveRule(rules, index, delta) {
  const to = index + delta;
  if (to < 0 || to >= rules.length) return [...rules];
  const out = [...rules];
  const [x] = out.splice(index, 1);
  out.splice(to, 0, x);
  return out;
}

// Counts per rule using the daemon's own annotation, so the number shown is
// produced by the evaluator that actually runs -- never a second copy of the
// matching logic in the browser. Matches on ruleId (never `rule`, the
// display name two rules can share -- see this module's own doc).
//
// Returns { total, trackable } per rule, not a single number: `aircraft` is
// the only_trackable:false population (state.adsb.aircraft -- every plane in
// range, not just the ones the agent could actually act on), so `total`
// alone can read e.g. "9" while zero of those nine are reachable/sun-safe/
// in-sector/fresh enough to track. `trackable` is the subset with
// a.trackable === true (AircraftRow already carries it), so the panel can
// render "N of M" and show both numbers -- the whole point of a panel whose
// job is answering "why isn't it tracking".
export function countMatches(rules, aircraft) {
  return rules.map((r) => {
    const matched = aircraft.filter((a) => a.ruleId === r.id);
    return { total: matched.length, trackable: matched.filter((a) => a.trackable === true).length };
  });
}

// ---------------------------------------------------------------------------
// Field/operator vocabulary. Mirrors src/policy/rules.ts's NUMERIC_FIELDS/
// SET_FIELDS/PREDICATES exactly (duplicated here, not imported: this file is
// vanilla JS served straight to the browser with no bundler, and the daemon
// side is compiled TypeScript under src/ -- see this module's own doc). Keep
// these two lists in sync by hand if the evaluator's vocabulary ever grows.
// ---------------------------------------------------------------------------

export const NUMERIC_FIELDS = [
  "climb_fpm", "altitude_m", "track_deg", "range_km",
  "elevation_deg", "ground_speed_kt", "est_track_sec",
];
export const SET_FIELDS = ["category", "type"];
export const PREDICATES = ["is_military", "is_large_military"];
const NUMERIC_OPS = ["gte", "lte", "within", "not_within"];
const OP_LABEL = { gte: "≥", lte: "≤", within: "within", not_within: "not within" };

// ---------------------------------------------------------------------------
// DOM layer -- thin, and NOT unit-tested (see this module's own doc).
//
// Two rendering paths, same split sector.js uses and for the same reason:
// drawer.js's _renderBody() only rewrites #drawer-body's innerHTML when the
// entry's registered (zero-arg) renderer returns a DIFFERENT string than last
// time. renderPolicyEntry() below is that renderer, and it is a CONSTANT
// string -- it never bakes rule data into itself -- so an ordinary ~1Hz
// SSE-driven drawer.refresh() while the Policy entry is open never touches
// the DOM at all. Everything dynamic is painted separately, straight into
// the constant shell's #policy-rows container:
//
//   renderPolicyPanel(root, state) -- a FULL rebuild of the row list and any
//     expanded editor, from policyLocal (this module's local ruleset) and
//     the most recently seen aircraft list. Called on navigating into the
//     entry and after every add/delete/reorder/edit action -- i.e. only on
//     a discrete operator action, never on a bare tick.
//   paintPolicyCounts(root, aircraft) -- touches ONLY the `.policy-count`
//     text nodes, every SSE tick, unconditionally (a no-op if the entry
//     isn't mounted). This is what makes the match counts genuinely live
//     (an aircraft can cross a threshold on its own, with no operator
//     action) WITHOUT rebuilding the row list on a timer: a full rebuild
//     on every tick would steal focus out from under an operator mid-typing
//     a rule name every ~1s -- the exact class of bug drawer.js's own
//     _renderBody() doc already catalogues (mousedown/mouseup losing their
//     target, scroll position resetting, focus loss) for the identical
//     reason (an unconditional innerHTML rewrite on a ~1Hz timer).
//
// policyLocal is the source of truth between edits, same as sector.js's
// sectorLocal: seeded ONCE from the first FRESH state.policy this module
// sees (there is no standalone GET /api/policy the way sector has GET
// /api/sector -- the ruleset rides the normal /api/state snapshot instead,
// per this task's brief), then only ever pushed via POST
// /api/control/policy/set, never re-adopted from a later tick. Re-adopting
// on every tick would silently discard an in-progress edit the instant the
// next SSE frame landed.
//
// "Fresh" (state.policyFresh, see src/dashboard/state.ts's doc) is load-
// bearing here, not decorative: state.policy is ALWAYS a fully-formed
// Ruleset -- server.ts's mergeState collapses a not-yet-polled or timed-out
// getPolicy leg to DEFAULT_RULESET so the panel never renders "no rules".
// That collapse is indistinguishable from "the operator's saved ruleset
// happens to equal the defaults" unless something else says so. Without the
// freshness gate: operator saves a real ruleset -> reloads the dashboard (or
// tb3-mcp restarts) -> that tick's getPolicy leg times out (COLLECT_CALL_
// TIMEOUT_MS, 4s -- not exotic on this rig's 2.4GHz band) -> policyLocal
// seeds from the DEFAULT_RULESET fallback, indistinguishable on screen from
// the real thing -> operator toggles one rule -> schedulePolicySave POSTs
// the whole (now-default) policyLocal.rules, silently overwriting their
// saved ruleset. A toast reads success throughout.
export let policyLocal = { version: 1, rules: [] };
let policySeeded = false;
let lastAircraft = [];
// Which rule's editor is currently expanded, if any -- module state, not
// per-rule state, since only one editor is ever open at a time.
let expandedRuleId = null;

function seedPolicyOnce(ruleset, fresh) {
  if (policySeeded) return;
  if (!fresh) return; // not-yet-polled or a failed/timed-out leg -- see this module's doc above
  if (ruleset && Array.isArray(ruleset.rules)) {
    policyLocal = {
      version: 1,
      rules: ruleset.rules.map((r) => ({ ...r, conditions: r.conditions.map((c) => ({ ...c })) })),
    };
    policySeeded = true;
  }
}

// Exported so app.js can seed policyLocal from EVERY tick's state.policy
// (cheap and a no-op after the first successful seed -- see seedPolicyOnce),
// not only when the Policy entry happens to already be open. Without this,
// an operator who opens the Policy entry before the first real SSE tick
// lands (paintPolicyCounts alone never seeds) would see an empty ruleset
// forever, since paintPolicyCounts is the only thing later ticks drive.
// `fresh` must be state.policyFresh -- see this module's doc above for why
// the plain ruleset alone is not enough to seed from.
export function seedPolicy(ruleset, fresh) {
  seedPolicyOnce(ruleset, fresh);
}

// 1-based position among ENABLED rules, mirroring evaluate()'s own tier
// numbering (src/policy/rules.ts) -- null for a disabled rule, which has no
// tier at all until it's turned back on.
function computeTiers(rules) {
  let t = 0;
  return rules.map((r) => (r.enabled ? ++t : null));
}

function firstValidationError(rules) {
  for (const r of rules) {
    const msg = validateRule(r);
    if (msg) return { ruleId: r.id, msg };
  }
  return null;
}

function conditionKind(c) {
  if (c && c.predicate) return "predicate";
  if (c && c.op === "in") return "set";
  return "numeric";
}

function defaultConditionFor(kind) {
  if (kind === "predicate") return { predicate: PREDICATES[0] };
  if (kind === "set") return { field: SET_FIELDS[0], op: "in", values: [] };
  return { field: NUMERIC_FIELDS[0], op: "gte", value: null };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Same defensive query helper sector.js/drawer.js use -- a no-op (never a
// throw) when `root` doesn't currently expose the requested node, which is
// the normal case whenever the Policy entry isn't the one mounted.
function q(root, selector) {
  return root && typeof root.querySelector === "function" ? root.querySelector(selector) : null;
}

function qAll(root, selector) {
  return root && typeof root.querySelectorAll === "function" ? Array.from(root.querySelectorAll(selector)) : [];
}

// The Policy drawer entry's CONSTANT shell (see this module's own doc on why
// constancy matters). Registered via drawer.setEntryRenderer("policy", ...);
// everything inside #policy-rows is painted afterward, never baked in here.
export function renderPolicyEntry() {
  return `
    <div class="policy-body">
      <p class="policy-intro muted">
        First matching ENABLED rule wins, top to bottom. A rule with no
        conditions matches every aircraft -- keep those at the bottom.
      </p>
      <div id="policy-rows" class="policy-rows"></div>
      <div class="policy-toolbar">
        <button type="button" class="policy-btn" data-act="add-rule">+ Add rule</button>
        <span id="policy-toolbar-error" class="policy-error-msg"></span>
        <button type="button" id="policy-save" class="policy-btn policy-save" data-act="save">Save</button>
      </div>
    </div>
  `;
}

function renderConditionFields(ruleId, ci, c) {
  const kind = conditionKind(c);
  if (kind === "predicate") {
    const options = PREDICATES.map((p) =>
      `<option value="${p}"${p === c.predicate ? " selected" : ""}>${p}</option>`).join("");
    return `<select class="cond-predicate" data-rule-id="${ruleId}" data-cond-index="${ci}">${options}</select>`;
  }
  if (kind === "set") {
    const fieldOptions = SET_FIELDS.map((f) =>
      `<option value="${f}"${f === c.field ? " selected" : ""}>${f}</option>`).join("");
    const values = Array.isArray(c.values) ? c.values.join(", ") : "";
    return `
      <select class="cond-field" data-rule-id="${ruleId}" data-cond-index="${ci}">${fieldOptions}</select>
      <span class="cond-op-label">in</span>
      <input type="text" class="cond-values" data-rule-id="${ruleId}" data-cond-index="${ci}"
             value="${escapeHtml(values)}" placeholder="comma-separated values">
    `;
  }
  const fieldOptions = NUMERIC_FIELDS.map((f) =>
    `<option value="${f}"${f === c.field ? " selected" : ""}>${f}</option>`).join("");
  const opOptions = NUMERIC_OPS.map((o) =>
    `<option value="${o}"${o === c.op ? " selected" : ""}>${OP_LABEL[o]}</option>`).join("");
  const needsValue2 = c.op === "within" || c.op === "not_within";
  return `
    <select class="cond-field" data-rule-id="${ruleId}" data-cond-index="${ci}">${fieldOptions}</select>
    <select class="cond-op" data-rule-id="${ruleId}" data-cond-index="${ci}">${opOptions}</select>
    <input type="number" class="cond-value" data-rule-id="${ruleId}" data-cond-index="${ci}"
           value="${c.value ?? ""}">
    ${needsValue2 ? `<input type="number" class="cond-value2" data-rule-id="${ruleId}" data-cond-index="${ci}" value="${c.value2 ?? ""}">` : ""}
  `;
}

function renderConditionRow(ruleId, c, ci) {
  const kind = conditionKind(c);
  const kindOptions = ["numeric", "set", "predicate"].map((k) =>
    `<option value="${k}"${k === kind ? " selected" : ""}>${k}</option>`).join("");
  return `
    <div class="policy-condition" data-rule-id="${ruleId}" data-cond-index="${ci}">
      <select class="cond-kind" data-rule-id="${ruleId}" data-cond-index="${ci}">${kindOptions}</select>
      ${renderConditionFields(ruleId, ci, c)}
      <button type="button" class="cond-remove" data-act="remove-condition"
              data-rule-id="${ruleId}" data-cond-index="${ci}" aria-label="remove condition">&times;</button>
    </div>
  `;
}

function renderEditor(rule, errMsg) {
  return `
    <div class="policy-editor" data-rule-id="${rule.id}">
      <label class="policy-name-label">Name
        <input type="text" class="policy-name-input" data-rule-id="${rule.id}" value="${escapeHtml(rule.name)}">
      </label>
      <label class="policy-preempt-label">
        <input type="checkbox" class="policy-preempt-cb" data-rule-id="${rule.id}"${rule.canPreempt ? " checked" : ""}>
        can interrupt a pass
      </label>
      <div class="policy-conditions">
        ${rule.conditions.map((c, ci) => renderConditionRow(rule.id, c, ci)).join("")}
      </div>
      <button type="button" class="policy-btn policy-add-condition" data-act="add-condition" data-rule-id="${rule.id}">+ Condition</button>
      ${errMsg ? `<div class="policy-row-error">${escapeHtml(errMsg)}</div>` : ""}
    </div>
  `;
}

// "N of M": N = matched AND currently trackable (what the agent could
// actually act on), M = every matched aircraft in range regardless of
// trackability. Always both numbers -- see countMatches's own doc for why a
// single count over the wrong population is actively misleading for a panel
// whose job is "why isn't it tracking".
function formatCount(count) {
  return `${count.trackable} of ${count.total}`;
}

function renderRow(rule, index, tier, count, ruleCount, errMsg) {
  const expanded = expandedRuleId === rule.id;
  return `
    <div class="policy-row${expanded ? " policy-row-expanded" : ""}" data-rule-id="${rule.id}">
      <span class="policy-tier">${tier === null ? "—" : tier}</span>
      <label class="policy-enable-label">
        <input type="checkbox" class="policy-enabled-cb" data-rule-id="${rule.id}"${rule.enabled ? " checked" : ""}>
      </label>
      <span class="policy-name">${escapeHtml(rule.name)}</span>
      <span class="policy-count" data-rule-id="${rule.id}" title="trackable of total aircraft currently matching this rule">${formatCount(count)}</span>
      <span class="policy-row-actions">
        <button type="button" class="policy-btn policy-move" data-act="move-up" data-rule-id="${rule.id}"${index === 0 ? " disabled" : ""} aria-label="move up">&#9650;</button>
        <button type="button" class="policy-btn policy-move" data-act="move-down" data-rule-id="${rule.id}"${index === ruleCount - 1 ? " disabled" : ""} aria-label="move down">&#9660;</button>
        <button type="button" class="policy-btn" data-act="toggle-edit" data-rule-id="${rule.id}">${expanded ? "Close" : "Edit"}</button>
        <button type="button" class="policy-btn policy-delete" data-act="delete-rule" data-rule-id="${rule.id}">Delete</button>
      </span>
    </div>
    ${expanded ? renderEditor(rule, errMsg) : ""}
  `;
}

// Full rebuild of #policy-rows plus the toolbar's save/error state, from
// policyLocal and the most recently known aircraft list. `state` is the
// dashboard's SSE snapshot when called from a tick/navigation (seeds
// policyLocal on first sight, refreshes the cached aircraft list); pass
// `null` to redraw after a local edit without touching either (the pattern
// every click/change handler in wirePolicyDelegates below uses).
export function renderPolicyPanel(root, state) {
  if (state) {
    seedPolicyOnce(state.policy, state.policyFresh);
    if (state.adsb && Array.isArray(state.adsb.aircraft)) lastAircraft = state.adsb.aircraft;
  }
  const rowsEl = q(root, "#policy-rows");
  if (!rowsEl) return; // Policy entry isn't currently mounted -- nothing to paint

  const rules = policyLocal.rules;
  const tiers = computeTiers(rules);
  const counts = countMatches(rules, lastAircraft);
  const err = firstValidationError(rules);

  rowsEl.innerHTML = rules.length === 0
    ? `<p class="policy-empty muted">No rules yet -- every aircraft is untracked. "+ Add rule" to start.</p>`
    : rules.map((r, i) => renderRow(r, i, tiers[i], counts[i], rules.length, r.id === (err && err.ruleId) ? err.msg : null)).join("");

  const saveBtn = q(root, "#policy-save");
  if (saveBtn) saveBtn.disabled = !!err;
  const toolbarErr = q(root, "#policy-toolbar-error");
  if (toolbarErr) toolbarErr.textContent = err ? `Can't save: ${err.msg}` : "";
}

// Live match-count refresh, every SSE tick, unconditionally -- see this
// module's own doc for why this is a SEPARATE, narrower paint than
// renderPolicyPanel's full rebuild (never touches an open editor's inputs,
// so it can run on a timer without stealing focus mid-edit).
export function paintPolicyCounts(root, aircraft) {
  lastAircraft = Array.isArray(aircraft) ? aircraft : [];
  if (!q(root, "#policy-rows")) return; // not currently mounted
  const counts = countMatches(policyLocal.rules, lastAircraft);
  policyLocal.rules.forEach((rule, i) => {
    const el = q(root, `.policy-count[data-rule-id="${rule.id}"]`);
    if (el) el.textContent = formatCount(counts[i]);
  });
}

// Debounced so a burst of edits (typing a name, ticking several checkboxes)
// posts once, not once per keystroke/click -- same rationale and constant
// shape as sector.js's postSectorDebounced.
const POLICY_SAVE_DEBOUNCE_MS = 400;
let policySaveTimer = null;

// E-STOP-latched refusal message, shared by the debounced auto-save and the
// explicit Save button below so the wording never drifts between the two
// paths. A policy write commands no motion -- the gate itself is correct
// and stays -- but returning silently left the operator pressing Save with
// no feedback at all, unable to tell "saved" from "did nothing".
const ESTOP_SAVE_BLOCKED_MSG = "policy not saved -- E-STOP is latched";

function schedulePolicySave(postControl, isEstopLatched, toast) {
  if (policySaveTimer !== null) clearTimeout(policySaveTimer);
  policySaveTimer = setTimeout(() => {
    policySaveTimer = null;
    if (firstValidationError(policyLocal.rules)) return; // still invalid -- do not persist a broken ruleset
    if (isEstopLatched()) { toast(ESTOP_SAVE_BLOCKED_MSG, false); return; } // matches sector.js's write-gate convention
    postControl("policy/set", { ruleset: { version: 1, rules: policyLocal.rules } });
  }, POLICY_SAVE_DEBOUNCE_MS);
}

// Attaches the checkbox/button/select/input listeners ONCE, delegated on
// `root` (app.js passes #drawer-body, same stable node sector.js/
// joystick-panel.js delegate on) -- see sector.js's own doc for why
// delegation on a node drawer.js never recreates means no re-wiring is ever
// needed across a navigate-away-and-back.
export function wirePolicyDelegates(root, { postControl, isEstopLatched, toast }) {
  if (!root || typeof root.addEventListener !== "function") return;

  function mutate(fn) {
    policyLocal = { ...policyLocal, rules: fn(policyLocal.rules) };
    renderPolicyPanel(root, null);
    schedulePolicySave(postControl, isEstopLatched, toast);
  }

  root.addEventListener("click", (evt) => {
    const target = evt.target.closest ? evt.target.closest("[data-act]") : null;
    if (!target) return;
    const act = target.dataset.act;
    const ruleId = target.dataset.ruleId;

    if (act === "add-rule") {
      const rule = newRule();
      expandedRuleId = rule.id;
      mutate((rules) => [...rules, rule]);
      return;
    }
    if (act === "save") {
      if (policySaveTimer !== null) { clearTimeout(policySaveTimer); policySaveTimer = null; }
      if (firstValidationError(policyLocal.rules)) return;
      if (isEstopLatched()) { toast(ESTOP_SAVE_BLOCKED_MSG, false); return; }
      postControl("policy/set", { ruleset: { version: 1, rules: policyLocal.rules } });
      return;
    }
    if (!ruleId) return;
    if (act === "delete-rule") {
      if (expandedRuleId === ruleId) expandedRuleId = null;
      mutate((rules) => rules.filter((r) => r.id !== ruleId));
      return;
    }
    if (act === "toggle-edit") {
      expandedRuleId = expandedRuleId === ruleId ? null : ruleId;
      renderPolicyPanel(root, null);
      return;
    }
    if (act === "move-up" || act === "move-down") {
      const delta = act === "move-up" ? -1 : 1;
      mutate((rules) => {
        const index = rules.findIndex((r) => r.id === ruleId);
        return index === -1 ? rules : moveRule(rules, index, delta);
      });
      return;
    }
    if (act === "add-condition") {
      mutate((rules) => rules.map((r) =>
        r.id === ruleId ? { ...r, conditions: [...r.conditions, defaultConditionFor("numeric")] } : r));
      return;
    }
    if (act === "remove-condition") {
      const ci = Number(target.dataset.condIndex);
      mutate((rules) => rules.map((r) =>
        r.id === ruleId ? { ...r, conditions: r.conditions.filter((_, i) => i !== ci) } : r));
      return;
    }
  });

  root.addEventListener("change", (evt) => {
    const target = evt.target;
    const ruleId = target.dataset ? target.dataset.ruleId : undefined;
    if (!ruleId) return;

    if (target.classList.contains("policy-enabled-cb")) {
      mutate((rules) => rules.map((r) => (r.id === ruleId ? { ...r, enabled: !!target.checked } : r)));
      return;
    }
    if (target.classList.contains("policy-preempt-cb")) {
      mutate((rules) => rules.map((r) => (r.id === ruleId ? { ...r, canPreempt: !!target.checked } : r)));
      return;
    }
    if (target.classList.contains("policy-name-input")) {
      mutate((rules) => rules.map((r) => (r.id === ruleId ? { ...r, name: target.value } : r)));
      return;
    }

    const ci = Number(target.dataset.condIndex);
    if (Number.isNaN(ci)) return;

    if (target.classList.contains("cond-kind")) {
      mutate((rules) => rules.map((r) => (r.id !== ruleId ? r : {
        ...r,
        conditions: r.conditions.map((c, i) => (i === ci ? defaultConditionFor(target.value) : c)),
      })));
      return;
    }
    if (target.classList.contains("cond-predicate")) {
      mutate((rules) => rules.map((r) => (r.id !== ruleId ? r : {
        ...r,
        conditions: r.conditions.map((c, i) => (i === ci ? { predicate: target.value } : c)),
      })));
      return;
    }
    if (target.classList.contains("cond-field")) {
      mutate((rules) => rules.map((r) => (r.id !== ruleId ? r : {
        ...r,
        conditions: r.conditions.map((c, i) => (i === ci ? { ...c, field: target.value } : c)),
      })));
      return;
    }
    if (target.classList.contains("cond-op")) {
      mutate((rules) => rules.map((r) => (r.id !== ruleId ? r : {
        ...r,
        conditions: r.conditions.map((c, i) => {
          if (i !== ci) return c;
          const needsValue2 = target.value === "within" || target.value === "not_within";
          return needsValue2
            ? { field: c.field, op: target.value, value: c.value ?? null, value2: c.value2 ?? null }
            : { field: c.field, op: target.value, value: c.value ?? null };
        }),
      })));
      return;
    }
    if (target.classList.contains("cond-value") || target.classList.contains("cond-value2")) {
      const key = target.classList.contains("cond-value2") ? "value2" : "value";
      const num = target.value === "" ? null : Number(target.value);
      mutate((rules) => rules.map((r) => (r.id !== ruleId ? r : {
        ...r,
        conditions: r.conditions.map((c, i) => (i === ci ? { ...c, [key]: Number.isNaN(num) ? null : num } : c)),
      })));
      return;
    }
    if (target.classList.contains("cond-values")) {
      const values = target.value.split(",").map((v) => v.trim()).filter((v) => v !== "");
      mutate((rules) => rules.map((r) => (r.id !== ruleId ? r : {
        ...r,
        conditions: r.conditions.map((c, i) => (i === ci ? { ...c, values } : c)),
      })));
      return;
    }
  });
}
