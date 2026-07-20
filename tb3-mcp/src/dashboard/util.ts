// Bounds a promise to `ms` milliseconds so a wedged dependency can't stall
// its caller forever.
//
// Why this exists: the MCP SDK's client.callTool() falls back to a 60s
// default request timeout. A daemon that accepts the TCP connection but
// never replies (rather than cleanly refusing/erroring) would otherwise
// freeze an `Aggregator.poll()` tick for up to 60s (stalling SSE via the
// `running` guard in server.ts) or lag an E-STOP leg's result by as much.
// Used to wrap the per-call `client.get*()` legs in collect() and the
// stopTracking/agentStop legs in ControlDeps.
//
// The wrapped promise is left to settle on its own after the timeout fires
// (this only races it, it does not cancel/abort it) — callers only see the
// timeout rejection, and log/telemetry from a late resolution, if any, is
// simply discarded.
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}: timed out after ${ms}ms`));
    }, ms);
    p.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}
