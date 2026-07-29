// Dashboard smoke test: real headless-browser clicks against dashboard/
// public/, run against a self-contained scripted mock server (no real
// rig/MCP stack needed).
//
// WHY THIS EXISTS: this exact file's own branch has produced FIVE separate
// defects that `npm test`/`npm run build`/`tsc` all stayed green through,
// because none of them exercise real DOM wiring in a browser:
//   - the E-STOP button's click listener was silently dropped during an
//     app.js restructure (task 10) -- E-STOP was completely dead, and
//     nothing but a real .click() caught it;
//   - three separate #topbar/#drawer occlusion bugs (tasks 4, 9 x2, 10),
//     each only reproducible by growing #topbar and real-clicking through
//     the drawer's nav afterward;
//   - a stray reference to a renamed identifier (task 10 fix round 1's own
//     E-STOP extraction) threw synchronously partway through app.js's
//     top-to-bottom module evaluation, silently aborting everything
//     textually AFTER it -- including the SSE connect and the first
//     render() call -- while everything wired BEFORE that point (E-STOP,
//     the drawer's nav) kept working. The first draft of THIS script
//     passed 10/10 anyway, because none of its checks depended on render()
//     having run; only a broader ad hoc "zero console errors" pass caught
//     it. Checks 1 and 6 below exist specifically to close that gap.
// This script is the guard: it is meant to be run after any change that
// touches app.js's bootstrap wiring, drawer.js, or the topbar/drawer CSS,
// and it fails loudly (non-zero exit, printed diagnostics) rather than
// passing quietly.
//
// WHAT IT CHECKS (real .click()/.mouse.*() calls that assert an effect --
// never `elementFromPoint` alone, which has already missed two of these):
//   1. app.js's render() pipeline actually reached the bottom of the file
//      (not just the top) -- #rig-connected reflects the scripted SSE tick.
//   2. E-STOP is reachable: a real click on #estop latches #estop-banner.
//   3. Clear/Resume is reachable: a real click on #estop-clear clears it.
//   4. All five Setup-drawer nav entries (calibration, travel-limits,
//      set-home, track-sector, joystick) are real-clickable and each
//      becomes the active nav item.
//   5. The topbar-growth case: grow #topbar at RUNTIME (after the page has
//      already loaded), confirm --topbar-h tracks it, and confirm a REAL
//      click still reaches the drawer's first nav entry afterward.
//   6. Zero uncaught JS errors across the entire run (checked last, so it
//      also covers every interaction above, not just page load).
//
// HOW TO RUN (from tb3-mcp/):
//   node scripts/dashboard-smoke.mjs
//
// Playwright is NOT a project dependency -- "no new npm dependencies" is a
// hard constraint on this branch, so this script does not get to add one on
// the operator's behalf. If Playwright isn't importable, this prints how to
// get it and exits non-zero; it does NOT skip its checks and report success.
// To make it importable:
//   npm install --no-save playwright && npx playwright install chromium
// (`--no-save` keeps it out of package.json/package-lock.json -- confirm
// with `git status` afterward). NODE_PATH does NOT help here: this
// package's package.json sets "type": "module", so Node's ESM resolver
// handles this file's `import("playwright")`, and the ESM resolver
// deliberately does not consult NODE_PATH (that env var only affects
// legacy CommonJS `require` resolution) -- verified empirically while
// writing this script, not assumed.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "dashboard", "public");
const PORT = 4591;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
};

// A single scripted DashboardState tick -- calibrated, so every drawer entry
// (including calibration's later steps) renders something real rather than
// a wall of blocked reasons. Shape matches src/dashboard/state.ts's
// DashboardState.
function scriptedState() {
  return {
    ts: Date.now(),
    services: { readsb: "active", tb3mcp: "active", tb3agent: "inactive", llama: "active" },
    rig: { connected: true, panDeg: 12.3, tiltDeg: 4.5, moving: false, batteryV: 12.1, telemetryAgeMs: 120, imu: null },
    mode: "manual",
    tracking: {
      state: "stopped", hex: null, callsign: null, targetAzDeg: null, targetElDeg: null,
      targetRangeM: null, pointingErrorDeg: null, panLimited: false, tiltLimited: false,
      offsetPanDeg: 0, offsetTiltDeg: 0,
    },
    calibration: {
      calibrated: true, rig: { lat: 33.38, lon: -112.14, height: 341 }, sightings: [{}, {}],
      solvedAt: new Date().toISOString(), provisional: false, imuMounting: { rmsDeg: 1.4 },
    },
    adsb: { rawCount: 0, aircraft: [], trackable: [] },
    sunGuard: { state: "clear", locked: false, separationDeg: 40, enabled: true },
    camera: { enabled: false, streaming: false, viewers: 0, source: "v4l2" },
    capture: { autoEnabled: false, recording: false, lastError: null, lastSkipReason: null, passIcao: null },
    errors: [],
    jog: { maxJogDps: 19, jogRampSeconds: 1.2, jogMinDps: 2 },
    limits: { panMinDeg: -170, panMaxDeg: 170, tiltMinDeg: -10, tiltMaxDeg: 80 },
    taughtLimits: { panMinDeg: null, panMaxDeg: null, tiltMinDeg: null, tiltMaxDeg: null },
  };
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);

      if (url.pathname === "/api/stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        const state = scriptedState();
        const timer = setInterval(() => res.write(`data: ${JSON.stringify(state)}\n\n`), 300);
        req.on("close", () => clearInterval(timer));
        res.write(`data: ${JSON.stringify(state)}\n\n`);
        return;
      }
      if (url.pathname === "/api/sector" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ startDeg: 45, endDeg: 315, enabled: false }));
      }
      if (url.pathname === "/camera/stream") {
        // camera-panel.js (a pure, untouched module) may probe this
        // regardless of camera.enabled; avoids console noise unrelated to
        // what this script actually checks.
        res.writeHead(200, { "Content-Type": "image/png" });
        return res.end(Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ));
      }
      if (url.pathname === "/api/control/estop" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          firmware: { ok: true, message: "stopped" },
          tracking: { ok: true, message: "stopped" },
          agent: { ok: true, message: "stopped" },
          allOk: true,
        }));
      }
      if (url.pathname.startsWith("/api/control/") && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, message: "ok" }));
      }

      let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      filePath = path.join(PUBLIC_DIR, filePath);
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end("not found: " + filePath); return; }
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(PORT, () => resolve(server));
  });
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    console.error(
      "\ndashboard-smoke.mjs needs Playwright, which is NOT a project dependency\n" +
      '("no new npm dependencies" is a hard constraint on this branch). Install\n' +
      "it once, outside package.json, then re-run this script:\n\n" +
      "  npm install --no-save playwright && npx playwright install chromium\n\n" +
      "(`--no-save` keeps it out of package.json/package-lock.json -- confirm with\n" +
      "`git status` afterward. NODE_PATH will NOT work here: this package has\n" +
      '"type": "module", so this import is resolved by Node\'s ESM loader, which\n' +
      "does not consult NODE_PATH.)\n",
    );
    return null;
  }
}

async function launchBrowser(chromium) {
  try {
    return await chromium.launch();
  } catch (e) {
    console.error(
      "\nFailed to launch a Chromium build via Playwright: " + (e instanceof Error ? e.message : String(e)) + "\n" +
      "If no browser binary is installed, run:\n\n" +
      "  npx playwright install chromium\n",
    );
    return null;
  }
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail ?? "" });
  console.log((cond ? "PASS" : "FAIL") + " -- " + name + (detail ? ` (${detail})` : ""));
}

async function main() {
  const pw = await loadPlaywright();
  if (!pw) process.exit(1);

  const browser = await launchBrowser(pw.chromium);
  if (!browser) process.exit(1);

  const server = await startServer();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    // Registered BEFORE goto(): app.js is a module script that runs top to
    // bottom on load -- an uncaught exception ANYWHERE in it (e.g. a stray
    // reference to a renamed/removed identifier) aborts everything textually
    // AFTER that point for the rest of the page's life, including the SSE
    // connect and the very first render() call at the bottom of the file.
    // That exact class of bug does NOT reliably fail the nav-entry/E-STOP
    // checks below (registered earlier in app.js, so still wired) -- it was
    // caught, during this task's own fix round, only by this listener.
    const jsErrors = [];
    page.on("pageerror", (err) => jsErrors.push(String(err)));

    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForTimeout(400);

    // Confirms app.js ran to completion, not just partway: #rig-connected
    // only reads "yes" once the real render(state) pipeline (bottom of
    // app.js, fed by the scripted SSE stream) has actually executed -- a
    // script that threw partway through and left `lastState` null would
    // instead show the pre-first-tick placeholder ("—"), the drawer nav
    // entries would render off null state, and the joystick control loop
    // would never have started.
    check(
      "app.js's render() pipeline reached the bottom of the file (rig-connected reflects the scripted SSE tick)",
      (await page.locator("#rig-connected").textContent()) === "yes",
    );

    // -- 1/2: E-STOP + Clear/Resume, real clicks that assert an effect --
    await page.click("#estop");
    await page.waitForTimeout(150);
    check("E-STOP: a real click on #estop latches #estop-banner", await page.locator("#estop-banner.show").count() === 1);

    await page.click("#estop-clear");
    await page.waitForTimeout(100);
    check("Clear/Resume: a real click on #estop-clear clears the latch", await page.locator("#estop-banner.show").count() === 0);

    // -- 3: all five drawer nav entries reachable and activate --
    await page.click("#drawer-open");
    await page.waitForTimeout(150);
    for (const entryId of ["calibration", "travel-limits", "set-home", "track-sector", "joystick"]) {
      await page.click(`[data-entry="${entryId}"]`, { timeout: 10000 });
      await page.waitForTimeout(80);
      const active = await page.locator(`.drawer-nav-item.drawer-nav-active[data-entry="${entryId}"]`).count();
      check(`drawer nav entry "${entryId}" is real-clickable and becomes active`, active === 1);
    }

    // -- 4: topbar-growth case -- grow #topbar AFTER load, confirm the fix
    // tracks it, and confirm a real click still reaches the drawer's first
    // nav entry (navigate off it first so the click is a genuine transition).
    const before = await page.evaluate(() => document.getElementById("topbar").offsetHeight);
    await page.evaluate(() => {
      const topbar = document.getElementById("topbar");
      topbar.style.paddingTop = "80px";
      topbar.style.paddingBottom = "80px";
    });
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({
      offsetHeight: document.getElementById("topbar").offsetHeight,
      cssVar: getComputedStyle(document.documentElement).getPropertyValue("--topbar-h").trim(),
    }));
    check("topbar growth: #topbar actually grew", after.offsetHeight > before + 50, `${before} -> ${after.offsetHeight}`);
    check("topbar growth: --topbar-h tracked the growth", after.cssVar === `${after.offsetHeight}px`, `cssVar=${after.cssVar}`);

    await page.click('[data-entry="travel-limits"]'); // move off calibration first
    await page.waitForTimeout(80);
    let clickTimedOut = false;
    try {
      await page.click('[data-entry="calibration"]', { timeout: 5000 });
    } catch {
      clickTimedOut = true;
    }
    await page.waitForTimeout(80);
    const active = await page.locator('.drawer-nav-item.drawer-nav-active[data-entry="calibration"]').count();
    check(
      "topbar growth: a REAL click still reaches and activates the Calibration nav entry",
      !clickTimedOut && active === 1,
    );

    // Checked LAST (not immediately after goto()) so it also covers every
    // interaction above -- a page that loads clean but throws on a later
    // click (e.g. a bad reference inside a handler wired well after load)
    // is exactly as broken as one that throws on load.
    check("zero uncaught JS errors for the whole run", jsErrors.length === 0, jsErrors.join(" | "));
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log("FAILED:");
    for (const f of failed) console.log(" - " + f.name + (f.detail ? ` :: ${f.detail}` : ""));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
