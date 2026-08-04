// Resolves the four operator-tunable values (see tuning-store.ts) against
// config: a tuned value wins when present, otherwise the config default
// applies. This is deliberately a pure, cheap function meant to be called at
// the MOMENT a value is used, not once at startup -- see each call site
// (track/session.ts, geo-tools.ts, capture/snapshot.ts) for why a
// startup-captured copy would defeat the whole feature (a tuning change
// would need a daemon restart to take effect).
import { Config } from "./config.js";
import { Tuning, TuningStore } from "./tuning-store.js";

// `tuning` is optional so a caller that never wired a TuningStore in (an
// older test harness, or a code path that genuinely has none) still gets
// config-only behavior rather than a crash.
export function resolveTuning(tuning: TuningStore | undefined, cfg: Config): Required<Tuning> {
  const t = tuning?.get() ?? {};
  return {
    maxAimOffsetDeg: t.maxAimOffsetDeg ?? cfg.maxAimOffsetDeg,
    calibVideoLatencyMs: t.calibVideoLatencyMs ?? cfg.calibVideoLatencyMs,
    trackLeadMs: t.trackLeadMs ?? cfg.trackLeadMs,
    captureTimeoutMs: t.captureTimeoutMs ?? cfg.captureTimeoutMs,
  };
}
