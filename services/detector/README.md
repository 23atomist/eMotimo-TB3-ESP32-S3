# TB3 aircraft detector

A small FastAPI sidecar that runs YOLOv8 (COCO class 4, "aeroplane") over a
single JPEG frame and returns detections as pixel offsets from frame centre.
It exists as a separate HTTP service — in the same pattern as `llama-server`
and `mediamtx` — so Python and the ML stack (PyTorch, ultralytics) stay out
of the Node `tb3-mcp` daemon. A crash here degrades tracking to its current
(vision-less) behaviour instead of taking the daemon down; `tb3-mcp/src/vision/detector-client.ts`
resolves `null` on any failure and the tracking loop treats that as "no
correction this cycle".

This directory is installed and run on the rig host, not in CI or the
TypeScript test suite. The client's contract with this service is pinned by
`tb3-mcp/test/vision-detector-client.test.ts` (against a local fake HTTP
server) and, on the rig itself, by the on-rig acceptance procedure in
`tb3-mcp/README.md`'s "Vision-lock" section (steps 1–2 of that procedure are
this file's own Setup section, below).

**Requires CUDA.** `app.py` calls `model.to("cuda")` at import time with no
CPU fallback, by design — on this rig (RTX 5080) a detector silently running
at CPU speed would be worse than one that refuses to start. On a host
without a working CUDA install, the service fails immediately at startup
instead of degrading; that failure is the intended, visible signal to the
operator that CUDA needs fixing, not a bug to route around.

## Setup (on the rig host)

1. Create a virtual environment in this directory:

   ```bash
   cd services/detector
   python3 -m venv .venv
   ```

2. Install dependencies:

   ```bash
   .venv/bin/pip install -r requirements.txt
   ```

3. Run it once by hand to confirm it starts and to let the first run
   download the model weights:

   ```bash
   .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8001
   ```

   The **first run downloads `yolov8n.pt`** (the YOLOv8 nano checkpoint)
   from Ultralytics into this directory (or the ultralytics cache dir) — it
   is not vendored in the repo. Subsequent runs reuse the cached weights.
   Confirm `curl http://127.0.0.1:8001/health` returns `{"ok": true}`, then
   stop the foreground process with Ctrl-C.

4. Install the systemd unit yourself, as the operator, since it needs sudo
   and this host requires a password for sudo (an agent should never attempt
   this step):

   ```bash
   sudo cp ../../tb3-mcp/deploy/tb3-detector.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now tb3-detector
   ```

5. Verify:

   ```bash
   sudo systemctl status tb3-detector
   curl http://127.0.0.1:8001/health
   ```

## API

`POST /detect` with `{"image_b64": "<base64 JPEG>", "min_conf": 0.25}`
returns:

```json
{"detections":[{"dxPx":112.0,"dyPx":-38.5,"conf":0.87}],"widthPx":1920,"heightPx":1080,"inferMs":3.1}
```

`dxPx`/`dyPx` are the detection centre relative to frame centre, computed
here so every client agrees on the convention rather than each one
re-deriving it.

`GET /health` returns `{"ok": true}` once the model is loaded.
