// Pure PPI geometry, shared by the browser (app.js imports it) and vitest.
// No DOM references at module scope, so Node/vitest can import it directly.

// Polar (compass bearing + range) -> screen pixels. North up, east right:
// screen x grows east, screen y grows DOWN, so north (az 0) is -y.
export function azRangeToXY(azDeg, rangeKm, maxRangeKm, cx, cy, radius) {
  const rPx = maxRangeKm > 0 ? (rangeKm / maxRangeKm) * radius : 0;
  const a = (azDeg * Math.PI) / 180;
  return { x: cx + rPx * Math.sin(a), y: cy - rPx * Math.cos(a) };
}

// Nearest dot to (px,py) within maxDistPx, or null. `dots` items have x/y.
export function nearestDot(dots, px, py, maxDistPx) {
  let best = null;
  let bestD2 = maxDistPx * maxDistPx;
  for (const d of dots) {
    const dx = d.x - px, dy = d.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestD2) { bestD2 = d2; best = d; }
  }
  return best;
}
