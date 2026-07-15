#if defined(ESP32)

#include "tb3_ota.h"
#include "tb3_web.h"      // tb3_ota_safe_to_flash / tb3_ota_prepare
#include <Update.h>
#include <ArduinoJson.h>

static volatile Tb3OtaState s_state = OTA_IDLE;
static volatile int s_progress = 0;
static char s_error[48] = "";

Tb3OtaState tb3_ota_state()   { return s_state; }
int         tb3_ota_progress(){ return s_progress; }
const char *tb3_ota_error()   { return s_error; }

static void fail(const char *msg) {
  snprintf(s_error, sizeof(s_error), "%s", msg);
  s_state = OTA_ERROR;
  Update.abort();
}

// Multipart upload: streamed chunk-by-chunk, never fully buffered in RAM.
static void onUpload(AsyncWebServerRequest *req, String filename, size_t index,
                     uint8_t *data, size_t len, bool final) {
  if (index == 0) {
    s_error[0] = 0; s_progress = 0;
    if (!tb3_ota_safe_to_flash()) { fail("busy - stop the program first"); return; }
    s_state = OTA_RUNNING;
    tb3_ota_prepare();                       // stop ISR + disable motors
    if (!Update.begin(UPDATE_SIZE_UNKNOWN)) { fail("Update.begin failed"); return; }
  }
  if (s_state != OTA_RUNNING) return;        // aborted earlier in this upload
  if (Update.write(data, len) != len)  { fail("flash write failed"); return; }
  // size is UNKNOWN to Update; approximate from the multipart body length.
  size_t total = req->contentLength();
  if (total) s_progress = (int)(((index + len) * 100) / total);
  if (final) {
    if (!Update.end(true)) { fail("Update.end failed"); return; }
    s_progress = 100;
    s_state = OTA_IDLE;                       // success; response triggers restart
  }
}

void tb3_ota_setup_web(AsyncWebServer &server) {
  server.on("/api/ota", HTTP_GET, [](AsyncWebServerRequest *req) {
    JsonDocument d;
    const char *st = (s_state == OTA_RUNNING) ? "running"
                   : (s_state == OTA_ERROR)   ? "error" : "idle";
    d["state"] = st;
    d["progress"] = s_progress;
    d["error"] = s_error;
    d["safe"] = tb3_ota_safe_to_flash();
    String out; serializeJson(d, out);
    AsyncWebServerResponse *r = req->beginResponse(200, "application/json", out);
    r->addHeader("Cache-Control", "no-store");
    req->send(r);
  });

  server.on("/api/ota", HTTP_POST,
    [](AsyncWebServerRequest *req) {           // completion handler
      bool ok = !Update.hasError() && s_state != OTA_ERROR;
      req->send(ok ? 200 : 400, "application/json",
                ok ? "{\"ok\":true}" : String("{\"error\":\"") + s_error + "\"}");
      if (ok) { delay(200); ESP.restart(); }
    },
    onUpload);
}

#endif // ESP32
