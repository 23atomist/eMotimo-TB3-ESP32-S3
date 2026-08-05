import { z } from "zod";
import { Candidate } from "./gate.js";

const ResponseSchema = z.object({
  detections: z.array(z.object({ dxPx: z.number(), dyPx: z.number(), conf: z.number() })),
  widthPx: z.number().positive(),
  heightPx: z.number().positive(),
  inferMs: z.number().nonnegative(),
});

export interface DetectResponse {
  detections: Candidate[]; widthPx: number; heightPx: number; inferMs: number;
}

export class DetectorClient {
  constructor(private readonly url: string, private readonly timeoutMs: number) {}

  // Resolves null on ANY failure. An exception escaping here would take down
  // the tracking loop; a skipped correction costs one cycle.
  async detect(jpegBase64: string, minConf: number): Promise<DetectResponse | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image_b64: jpegBase64, min_conf: minConf }),
        signal: ctl.signal,
      });
      if (!res.ok) return null;
      const parsed = ResponseSchema.safeParse(await res.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
