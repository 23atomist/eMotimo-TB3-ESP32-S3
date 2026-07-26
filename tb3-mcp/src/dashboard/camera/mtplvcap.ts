import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { Config } from "../../config.js";
import type { Spawner } from "./supervisor.js";
import { JpegFrameParser } from "./jpeg-parser.js";

// ---------------------------------------------------------------------------
// mtplvcapSpawner: NOT unit-tested (real subprocess + HTTP relay; on-host).
//
// Spawns mtplvcap, which opens the Nikon over USB, starts Live View, and serves
// an MJPEG stream on 127.0.0.1:<port>/mjpeg. We connect to that stream, split
// it into per-frame JPEGs, and push them. kill() aborts the HTTP read AND
// SIGINTs mtplvcap, which stops Live View and releases the camera's USB so the
// operator can shoot. mtplvcap self-recovers from a wedged MTP session on the
// next start (it resets the session), so an abrupt Stop doesn't brick the next
// Start.
// ---------------------------------------------------------------------------

// mtplvcap needs a moment to open the camera + start Live View + bind its port
// before /mjpeg accepts a connection; retry the connect across this window.
const CONNECT_RETRIES = 20;
const CONNECT_DELAY_MS = 500;
const NIKON_VENDOR_ID = "0x04b0";
// SIGINT lets mtplvcap stop Live View + close the MTP session cleanly. If it
// doesn't exit within this grace window, hard-kill it so the next start isn't
// blocked waiting on a hung process.
export const KILL_GRACE_MS = 4000;

// Only ONE mtplvcap may hold the camera's USB/PTP session (and the port) at a
// time -- overlapping instances fight over it and wedge the camera. This is
// module-scoped because the constraint is the single physical camera, not any
// one streamer: a new spawn waits for the previous process to fully exit (see
// begin() below) before starting.
let activeProc: ChildProcess | null = null;

export function mtplvcapSpawner(cfg: Config): Spawner {
  return {
    start(onFrame, onExit) {
      let stopped = false;
      let done = false;
      let attempts = 0;
      let proc: ChildProcess | null = null;
      const controller = new AbortController();
      const parser = new JpegFrameParser();
      const url = `http://127.0.0.1:${cfg.cameraMtplvcapPort}/mjpeg`;

      // SIGINT the child, with a bounded SIGKILL backstop so a hung mtplvcap
      // can't block the next start forever. Detaches our local handle
      // immediately; activeProc is cleared by the child's own exit handler.
      const stopProc = (): void => {
        const p = proc;
        if (!p) return;
        proc = null;
        try { p.kill("SIGINT"); } catch { /* already dead */ }
        const hard = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* dead */ } }, KILL_GRACE_MS);
        p.once("exit", () => clearTimeout(hard));
      };

      const finish = (code: number | null): void => {
        if (done) return;
        done = true;
        try { controller.abort(); } catch { /* noop */ }
        stopProc();
        if (!stopped) onExit(code);
      };

      const connect = async (): Promise<void> => {
        if (stopped || done) return;
        try {
          const res = await fetch(url, { signal: controller.signal });
          if (!res.ok || !res.body) throw new Error(`mjpeg HTTP ${res.status}`);
          const reader = res.body.getReader();
          for (;;) {
            const { done: rdone, value } = await reader.read();
            if (rdone) break;
            if (value) for (const frame of parser.push(Buffer.from(value))) onFrame(frame);
          }
          finish(0); // stream ended cleanly -- let the streamer restart if viewers remain
        } catch {
          if (stopped || done) return;
          attempts += 1;
          if (attempts >= CONNECT_RETRIES) { finish(1); return; }
          setTimeout(() => { void connect(); }, CONNECT_DELAY_MS);
        }
      };

      const begin = async (): Promise<void> => {
        // Serialize on the single camera: wait for any prior mtplvcap to exit
        // before spawning a new one, so two never contend for the USB session.
        while (activeProc && !stopped) {
          await once(activeProc, "exit").catch(() => { /* already exited */ });
        }
        if (stopped || done) return;
        const p = spawn(cfg.cameraMtplvcapBin, [
          "-host", "127.0.0.1",
          "-port", String(cfg.cameraMtplvcapPort),
          "-vendor-id", NIKON_VENDOR_ID,
        ], { stdio: "ignore" });
        proc = p;
        activeProc = p;
        p.on("exit", () => { if (activeProc === p) activeProc = null; finish(null); });
        p.on("error", () => finish(null));
        void connect();
      };
      void begin();

      return {
        kill(): void {
          stopped = true;
          try { controller.abort(); } catch { /* noop */ }
          stopProc();
        },
      };
    },
  };
}
