// The on-screen analog joystick widget: a circular pad with a draggable knob,
// pointer-captured, that reports ALREADY-SHAPED fractional deflections.
//
// This module owns INPUT SHAPING only -- geometry, deadzone, response curve,
// spring-back on release, and the disabled state (E-STOP/sun-lock dim it).
// It knows nothing about jog vs trim, rates, or the network: it calls
// onMove(fx, fy) continuously while dragged and onRelease() once when the
// gesture ends, with fx/fy in -1..1 (screen convention: LEFT is -x, UP is
// -y). stick-hold.js turns those into rig commands; keeping the two apart is
// what lets each be pinned by vitest without a browser.
//
// Shaping choices are inherited from joystick-math.js's USB-gamepad work,
// which solved these exact problems for a physical stick:
// - A radial DEADZONE so a centered knob at rest commands nothing (a touch
//   finger resting on the pad must not become a silent creep).
// - A SIGN-PRESERVING SQUARED response curve: small deflections map to
//   disproportionately small output (fine control at zoom), full deflection
//   still reaches exactly 1.0. Linear was explicitly ruled out for framing
//   work by that module's field history.

// Radial deadzone as a fraction of the pad radius. Smaller than the USB
// pad's 0.15: a touchscreen finger has no mechanical rest drift to forgive,
// but it does have tremor, and a hair-thin deadzone makes "let go" feel like
// the stick still has authority.
export const STICK_DEADZONE = 0.08;

// Sign-preserving square: f(v) = sign(v) * v^2 after deadzone rescale.
export const CURVE_EXPONENT = 2;

function shape(distanceFraction, axisValue) {
  if (distanceFraction <= STICK_DEADZONE) return 0;
  const linear = (distanceFraction - STICK_DEADZONE) / (1 - STICK_DEADZONE);
  const curved = Math.pow(linear, CURVE_EXPONENT);
  // Re-scale the AXIS component by the curved radial magnitude, preserving
  // direction: the curve shapes GAIN, not direction.
  const radialLinear = distanceFraction === 0 ? 0 : Math.abs(axisValue) / distanceFraction;
  return Math.sign(axisValue) * curved * radialLinear;
}

// Pure and exported: pixel offset from pad centre + pad radius -> the shaped
// fractional deflection pair. Unit-tested directly (no DOM needed), same
// rationale as joystick-math.js.
export function shapeDeflection(dxPx, dyPx, radiusPx) {
  if (!(radiusPx > 0)) return { fx: 0, fy: 0 };
  const distance = Math.hypot(dxPx, dyPx);
  const clampedDistance = Math.min(distance, radiusPx);
  const scale = distance === 0 ? 0 : clampedDistance / distance;
  const dxC = dxPx * scale, dyC = dyPx * scale;   // clamped to the rim
  const fraction = clampedDistance / radiusPx;
  return {
    fx: shape(fraction, dxC / radiusPx),
    fy: shape(fraction, dyC / radiusPx),
  };
}

export function createVirtualStick({
  mount,
  onMove,        // (fx, fy) => void, fired while the knob is held
  onRelease,     // () => void, fired once when the gesture ends
  size = 148,    // px, outer diameter of the pad
}) {
  if (!mount) return null;

  mount.classList.add("vstick");
  mount.style.width = `${size}px`;
  mount.style.height = `${size}px`;
  mount.innerHTML =
    '<div class="vstick-ring"></div>' +
    '<div class="vstick-cross"></div>' +
    '<div class="vstick-knob"></div>';
  const knob = mount.querySelector(".vstick-knob");

  let pointerId = null;
  let radiusPx = size / 2;
  let disabled = false;

  function setKnob(dxPx, dyPx) {
    knob.style.transform = `translate(calc(-50% + ${dxPx}px), calc(-50% + ${dyPx}px))`;
  }

  function centerKnob() {
    setKnob(0, 0);
  }

  function handleMove(evt) {
    if (disabled || pointerId === null || evt.pointerId !== pointerId) return;
    const rect = mount.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = evt.clientX - cx, dy = evt.clientY - cy;
    const { fx, fy } = shapeDeflection(dx, dy, radiusPx);
    // Knob follows the RAW (rim-clamped) position, not the shaped output --
    // the visual must track the finger 1:1 or the stick feels broken.
    const raw = Math.hypot(dx, dy);
    const k = raw > radiusPx ? radiusPx / raw : 1;
    setKnob(dx * k, dy * k);
    if (onMove) onMove(fx, fy);
  }

  function endGesture(evt) {
    if (pointerId === null || (evt && evt.pointerId !== undefined && evt.pointerId !== pointerId)) return;
    if (evt && mount.hasPointerCapture && mount.hasPointerCapture(evt.pointerId)) {
      mount.releasePointerCapture(evt.pointerId);
    }
    pointerId = null;
    centerKnob();
    if (onRelease) onRelease();
  }

  mount.addEventListener("pointerdown", (evt) => {
    if (disabled || pointerId !== null) return;
    evt.preventDefault();
    pointerId = evt.pointerId;
    if (mount.setPointerCapture) {
      try { mount.setPointerCapture(evt.pointerId); } catch { /* synthetic pointers may reject */ }
    }
    handleMove(evt);
  });
  mount.addEventListener("pointermove", handleMove);
  mount.addEventListener("pointerup", endGesture);
  mount.addEventListener("pointercancel", endGesture);
  // A pointerleave while captured still delivers pointerup to this element
  // (capture), so no separate leave handling is needed -- but an UNCAPTURED
  // stray leave with no active gesture must do nothing, which the
  // pointerId guard above already ensures.

  return {
    // E-STOP / sun-lock: dim and refuse new gestures; a drag already in
    // progress is force-released so a latched E-STOP cannot keep receiving
    // moves from a finger still down.
    setDisabled(v) {
      disabled = !!v;
      mount.classList.toggle("vstick-disabled", disabled);
      if (disabled) endGesture({ pointerId });
    },
    get disabled() { return disabled; },
    destroy() {
      mount.innerHTML = "";
      mount.classList.remove("vstick");
    },
  };
}
