#if defined(ESP32)

#include "tb3_ota.h"
#include "tb3_web.h"      // tb3_ota_safe_to_flash / tb3_ota_prepare
#include <Update.h>
#include <ArduinoJson.h>
#include <ArduinoOTA.h>
#include <WiFi.h>

static volatile Tb3OtaState s_state = TB3_OTA_IDLE;
static volatile int s_progress = 0;
static char s_error[48] = "";
static AsyncWebServerRequest *s_owner = nullptr;   // request currently flashing

Tb3OtaState tb3_ota_state()   { return s_state; }
int         tb3_ota_progress(){ return s_progress; }
const char *tb3_ota_error()   { return s_error; }

static void fail(const char *msg) {
  snprintf(s_error, sizeof(s_error), "%s", msg);
  s_state = TB3_OTA_ERROR;
  Update.abort();
}

// Multipart upload: streamed chunk-by-chunk, never fully buffered in RAM.
static void onUpload(AsyncWebServerRequest *req, String filename, size_t index,
                     uint8_t *data, size_t len, bool final) {
  if (index == 0) {
    // Reject a second upload while one is already flashing — WITHOUT touching
    // the Update singleton, so the in-flight write is never aborted.
    if (s_state == TB3_OTA_RUNNING) return;
    s_error[0] = 0; s_progress = 0;
    if (!tb3_ota_safe_to_flash()) { fail("busy - stop the program first"); return; }
    s_state = TB3_OTA_RUNNING;
    s_owner = req;
    // Free the Update singleton if the client vanishes before the final chunk;
    // otherwise a dropped upload wedges OTA until a power cycle.
    req->onDisconnect([req]() {
      if (s_state == TB3_OTA_RUNNING && req == s_owner) {
        Update.abort();
        s_state = TB3_OTA_ERROR;
        snprintf(s_error, sizeof(s_error), "upload disconnected");
        s_owner = nullptr;
      }
    });
    tb3_ota_prepare();                        // stop ISR + disable motors
    if (!Update.begin(UPDATE_SIZE_UNKNOWN)) { fail("Update.begin failed"); s_owner = nullptr; return; }
  }
  if (req != s_owner) return;                 // ignore chunks from a rejected upload
  if (s_state != TB3_OTA_RUNNING) return;         // aborted earlier
  if (Update.write(data, len) != len) { fail("flash write failed"); return; }
  // size is UNKNOWN to Update; approximate from the multipart body length.
  size_t total = req->contentLength();
  if (total) s_progress = (int)(((index + len) * 100) / total);
  if (final) {
    if (!Update.end(true)) { fail("Update.end failed"); return; }
    s_progress = 100;
    s_state = TB3_OTA_IDLE;                       // success; response triggers restart
  }
}

void tb3_ota_setup_web(AsyncWebServer &server) {
  server.on("/api/ota", HTTP_GET, [](AsyncWebServerRequest *req) {
    JsonDocument d;
    const char *st = (s_state == TB3_OTA_RUNNING) ? "running"
                   : (s_state == TB3_OTA_ERROR)   ? "error" : "idle";
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
      bool ok = (req == s_owner) && !Update.hasError() && s_state != TB3_OTA_ERROR;
      req->send(ok ? 200 : 400, "application/json",
                ok ? "{\"ok\":true}" : String("{\"error\":\"") + s_error + "\"}");
      if (ok) { s_owner = nullptr; delay(200); ESP.restart(); }
    },
    onUpload);
}

static void espotaTask(void *) {
  ArduinoOTA.setHostname("tb3");
  ArduinoOTA.setPort(3232);
  ArduinoOTA.onStart([]() {
    if (!tb3_ota_safe_to_flash()) {
      // ArduinoOTA has already called Update.begin() by now; a bare return does
      // NOT stop the transfer. Abort the Update session so the subsequent
      // write loop no-ops and the espota session fails without flashing.
      Update.abort();
      snprintf(s_error, sizeof(s_error), "busy - stop the program first");
      s_state = TB3_OTA_ERROR;
      return;
    }
    s_state = TB3_OTA_RUNNING; s_progress = 0;
    tb3_ota_prepare();
  });
  ArduinoOTA.onProgress([](unsigned int cur, unsigned int total) {
    if (total) s_progress = (int)((cur * 100) / total);
  });
  ArduinoOTA.onEnd([]() { s_progress = 100; s_state = TB3_OTA_IDLE; });
  ArduinoOTA.onError([](ota_error_t) {
    snprintf(s_error, sizeof(s_error), "espota error");
    s_state = TB3_OTA_ERROR;
  });
  ArduinoOTA.begin();
  for (;;) { ArduinoOTA.handle(); vTaskDelay(pdMS_TO_TICKS(20)); }
}

void tb3_ota_begin_espota() {
  xTaskCreatePinnedToCore(espotaTask, "tb3_espota", 8192, nullptr, 1, nullptr, 0);
}

#endif // ESP32
