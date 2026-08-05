import base64, io, time
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image
from ultralytics import YOLO

# COCO class 4 is "aeroplane". Fine-tuning for distant specks is a later
# concern; the consistency gate carries the reliability burden for now.
AIRCRAFT_CLASS_ID = 4
model = YOLO("yolov8n.pt")
model.to("cuda")
app = FastAPI()

class DetectRequest(BaseModel):
    image_b64: str
    min_conf: float = 0.25

@app.post("/detect")
def detect(req: DetectRequest):
    t0 = time.perf_counter()
    try:
        img = Image.open(io.BytesIO(base64.b64decode(req.image_b64))).convert("RGB")
    except Exception as e:
        # A dropped or truncated frame is an expected event, not a server
        # fault: answer cleanly instead of logging a traceback per frame.
        raise HTTPException(status_code=400, detail=f"undecodable image: {e}")
    w, h = img.size
    cx, cy = w / 2.0, h / 2.0
    res = model.predict(img, conf=req.min_conf, classes=[AIRCRAFT_CLASS_ID], verbose=False)[0]
    dets = []
    for b in res.boxes:
        x1, y1, x2, y2 = [float(v) for v in b.xyxy[0]]
        # Offset from FRAME CENTRE, computed here so every client agrees.
        dets.append({"dxPx": (x1 + x2) / 2.0 - cx, "dyPx": (y1 + y2) / 2.0 - cy,
                     "conf": float(b.conf[0])})
    return {"detections": dets, "widthPx": w, "heightPx": h,
            "inferMs": (time.perf_counter() - t0) * 1000.0}

@app.get("/health")
def health():
    return {"ok": True}
