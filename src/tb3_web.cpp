#if defined(ESP32)

#include "tb3_web.h"
#include "tb3_ui.h"
#include "tb3_ota.h"

#include <WiFi.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <AsyncJson.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include "soc/gpio_struct.h"
#include "tb3_imu.h"

// ---------------------------------------------------------------------------
// Firmware globals (defined in the concatenated .ino unit)
// ---------------------------------------------------------------------------
extern volatile uint8_t g_usb_joy_x;
extern volatile uint8_t g_usb_joy_y;
extern volatile uint16_t g_usb_accel_x;
extern volatile bool g_usb_button_c;
extern volatile bool g_usb_button_z;
extern int joy_x_axis_Offset;
extern int joy_y_axis_Offset;
extern int accel_x_axis_Offset;

// implemented in TB3_WebGlue.ino (needs .ino pin macros)
void tb3_cam_write(bool shutter, bool focus);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
static const char *AP_SSID = "TB3-Black";
static const char *AP_PASS = "tb3black109";
static const char *FW_VERSION = "109-esp32-1.1.0";
static const uint32_t JOY_DEADMAN_MS = 750;

// ---------------------------------------------------------------------------
// Pending input state: written by the network task, consumed by
// tb3_web_poll() in loopTask. Simple scalar writes only.
// ---------------------------------------------------------------------------
static volatile int8_t s_joy_x = 0, s_joy_y = 0, s_joy_aux = 0;
static volatile uint32_t s_joy_stamp = 0;       // millis of last joy update
// Set by /api/stop, cleared only when the client sends a centred joystick frame:
// you must let go before you can drive again.
//
// Without this, /api/stop is a no-op against any client that streams a jog vector
// continuously -- and layer 3's tracking servo streams one at 10Hz. The stop
// zeroes s_joy_*, then the client's next frame ~100ms later re-applies the old
// vector and the rig keeps going. Measured on the rig: /api/stop returned
// 200 {"ok":true} and the pan carried on for 3.0 degrees. Latching the web input at
// centre is what makes the stop mean something against a machine that never
// stops asking. Deliberately scoped to the web path only -- a physical gamepad
// operator is not locked out by a web client's stop.
static volatile bool s_joy_stop_latched = false;
static volatile uint32_t s_btn_c_until = 0;
static volatile uint32_t s_btn_z_until = 0;
static volatile uint32_t s_cam_shutter_until = 0;
static volatile uint32_t s_cam_focus_until = 0;
static volatile bool s_stop_request = false;
static volatile bool s_home_request = false;
static volatile bool  s_goto_request = false;
static volatile float s_goto_pan_deg = 0, s_goto_tilt_deg = 0, s_goto_speed_dps = 0;
static volatile bool s_wifi_reconnect = false;
static bool s_cam_active = false;               // loopTask-only

// wiring test: toggle one output pin at 2Hz so it can be probed with a
// meter/LED. Applied from tb3_web_poll (loopTask).
static volatile int16_t s_pintest_gpio = -1;
static volatile uint32_t s_pintest_until = 0;

static Preferences s_prefs;
static AsyncWebServer s_server(80);
static AsyncWebSocket s_ws("/ws");
static bool s_mdns_up = false;

// Latest IMU sample, refreshed once per telemetry tick (5Hz) by telemetryTask.
static Tb3ImuSample s_imu_live = {};
static bool s_imu_live_ok = false;
// Holds the /api/imu burst body while it streams (the chunked filler below reads
// it after the handler returns, so it must outlive the handler). Single-client
// bench endpoint; concurrent /api/imu callers would race this.
static String s_imu_json;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
static void jsonEscapeInto(char *dst, size_t dstlen, const char *src) {
  // LCD content is printable ASCII; neutralize the two JSON-breaking chars.
  size_t j = 0;
  for (size_t i = 0; src[i] && j + 1 < dstlen; i++) {
    char c = src[i];
    dst[j++] = (c == '"' || c == '\\') ? ' ' : c;
  }
  dst[j] = 0;
}

static void applyInputCommand(JsonVariantConst doc) {
  const char *t = doc["t"] | "";
  if (!strcmp(t, "joy") || doc["x"].is<int>()) {
    s_joy_x = (int8_t)constrain((int)(doc["x"] | 0), -100, 100);
    s_joy_y = (int8_t)constrain((int)(doc["y"] | 0), -100, 100);
    s_joy_aux = (int8_t)constrain((int)(doc["aux"] | 0), -100, 100);
    s_joy_stamp = millis();
    // Release the stop latch only on an explicit centred frame. Note s_joy_* still
    // tracks the client's raw intent while latched; tb3_web_poll() is what refuses
    // to act on it. That keeps the deadman's staleness logic untouched.
    if (s_joy_stop_latched && !s_joy_x && !s_joy_y && !s_joy_aux) s_joy_stop_latched = false;
  }
  if (!strcmp(t, "btn")) {
    uint32_t ms = constrain((int)(doc["ms"] | 300), 30, 2000);
    const char *b = doc["b"] | "";
    if (!strcmp(b, "c")) s_btn_c_until = millis() + ms;
    if (!strcmp(b, "z")) s_btn_z_until = millis() + ms;
  }
}

static size_t buildTick(char *buf, size_t len) {
  Tb3Status st = tb3_get_status();
  char l1[17], l2[17], e1[24], e2[24];
  tb3_get_lcd(l1, l2);
  jsonEscapeInto(e1, sizeof(e1), l1);
  jsonEscapeInto(e2, sizeof(e2), l2);
  char sta[20] = "";
  if (WiFi.status() == WL_CONNECTED) {
    snprintf(sta, sizeof(sta), "%s", WiFi.localIP().toString().c_str());
  }
  // Sensor-frame gravity angles (NOT boresight tilt — see the IMU spec).
  float pitch = 0, roll = 0;
  if (s_imu_live_ok) {
    pitch = atan2f(-s_imu_live.ax, sqrtf(s_imu_live.ay * s_imu_live.ay + s_imu_live.az * s_imu_live.az)) * 57.29578f;
    roll  = atan2f(s_imu_live.ay, s_imu_live.az) * 57.29578f;
  }
  return snprintf(buf, len,
    "{\"type\":\"tick\",\"lcd\":[\"%s\",\"%s\"],\"pos\":[%.0f,%.0f,%.0f],"
    "\"moving\":%u,\"prog\":%d,\"fired\":%u,\"total\":%u,\"batt\":%.2f,"
    "\"sta\":\"%s\","
    "\"imu\":{\"ok\":%s,\"pitch\":%.2f,\"roll\":%.2f,\"tempC\":%.2f,\"pressHpa\":%.2f}}",
    e1, e2, st.pan, st.tilt, st.aux,
    (unsigned)st.moving, st.program_engaged ? 1 : 0,
    st.camera_fired, st.camera_total, st.battery_v, sta,
    s_imu_live_ok ? "true" : "false", pitch, roll,
    s_imu_live_ok ? s_imu_live.tempC : 0.0f, s_imu_live_ok ? s_imu_live.pressHpa : 0.0f);
}

// ---------------------------------------------------------------------------
// Telemetry task (core 0): 5 Hz push to all WS clients
// ---------------------------------------------------------------------------
static void telemetryTask(void *) {
  char buf[512];
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(200));
    { Tb3ImuSample smp; if (tb3_imu_read(smp)) { s_imu_live = smp; s_imu_live_ok = true; } }
    s_ws.cleanupClients(4);
    if (s_ws.count() > 0) {
      size_t n = buildTick(buf, sizeof(buf));
      if (n > 0 && n < sizeof(buf)) s_ws.textAll(buf, n);
    }
    if (!s_mdns_up && WiFi.status() == WL_CONNECTED) {
      s_mdns_up = MDNS.begin("tb3");
      if (s_mdns_up) MDNS.addService("http", "tcp", 80);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------
static void sendJson(AsyncWebServerRequest *req, int code, const String &body) {
  AsyncWebServerResponse *r = req->beginResponse(code, "application/json", body);
  r->addHeader("Cache-Control", "no-store");
  req->send(r);
}

static void setupRoutes() {
  s_server.on("/", HTTP_GET, [](AsyncWebServerRequest *req) {
    AsyncWebServerResponse *r = req->beginResponse(200, "text/html", TB3_INDEX_HTML);
    req->send(r);
  });

  s_server.on("/api/status", HTTP_GET, [](AsyncWebServerRequest *req) {
    Tb3Status st = tb3_get_status();
    JsonDocument d;
    JsonObject pos = d["pos"].to<JsonObject>();
    pos["pan"] = st.pan; pos["tilt"] = st.tilt; pos["aux"] = st.aux;
    d["moving"] = st.moving;
    // A latched rig silently ignores jog input, which is exactly the kind of
    // no-error-no-motion failure this rig is already good at. Surface it.
    d["joy_latched"] = s_joy_stop_latched;
    d["progstep"] = st.progstep;
    d["progtype"] = st.progtype;
    d["program_engaged"] = st.program_engaged;
    d["camera_fired"] = st.camera_fired;
    d["camera_total"] = st.camera_total;
    d["interval_mode"] = st.interval_mode;
    d["battery_v"] = st.battery_v;
    d["uptime_ms"] = millis();
    d["heap"] = ESP.getFreeHeap();
    JsonObject wifi = d["wifi"].to<JsonObject>();
    wifi["ap_ip"] = WiFi.softAPIP().toString();
    wifi["sta_ip"] = (WiFi.status() == WL_CONNECTED) ? WiFi.localIP().toString() : "";
    wifi["clients"] = WiFi.softAPgetStationNum();
    JsonObject imu = d["imu"].to<JsonObject>();
    imu["ok"] = s_imu_live_ok;
    if (s_imu_live_ok) {
      float pitch = atan2f(-s_imu_live.ax, sqrtf(s_imu_live.ay * s_imu_live.ay + s_imu_live.az * s_imu_live.az)) * 57.29578f;
      float roll  = atan2f(s_imu_live.ay, s_imu_live.az) * 57.29578f;
      imu["pitch"] = pitch; imu["roll"] = roll;
      imu["tempC"] = s_imu_live.tempC; imu["pressHpa"] = s_imu_live.pressHpa;
    }
    String out; serializeJson(d, out);
    sendJson(req, 200, out);
  });

  s_server.on("/api/lcd", HTTP_GET, [](AsyncWebServerRequest *req) {
    char l1[17], l2[17];
    tb3_get_lcd(l1, l2);
    JsonDocument d;
    d["line1"] = l1; d["line2"] = l2;
    String out; serializeJson(d, out);
    sendJson(req, 200, out);
  });

  s_server.on("/api/info", HTTP_GET, [](AsyncWebServerRequest *req) {
    JsonDocument d;
    d["version"] = FW_VERSION;
    d["build"] = __DATE__ " " __TIME__;
    d["device"] = "eMotimo TB3 Black / ESP32-S3";
    String out; serializeJson(d, out);
    sendJson(req, 200, out);
  });

  // Wiring diagnostics: sample the GPIO output latch fast enough to catch
  // step pulses, and report each motor-related pin as low/high/pulsing.
  // Reads the register the firmware drives - a mismatch between this and
  // voltages measured on the driver board means a wiring problem.
  s_server.on("/api/pins", HTTP_GET, [](AsyncWebServerRequest *req) {
    static const struct { uint8_t gpio; const char *name; } PINS[] = {
      {5, "step_pan"}, {6, "step_tilt"}, {7, "step_aux"},
      {10, "dir_pan"}, {38, "dir_tilt"}, {12, "dir_aux"},
      {13, "en_pantilt_low_active"}, {14, "en_aux_low_active"},
      {15, "ms1"}, {16, "ms2"}, {17, "ms3"},
      {18, "camera"}, {21, "focus"},
    };
    uint32_t seenHigh = 0, seenLow = 0;   // GPIO 0-31
    uint32_t seenHigh1 = 0, seenLow1 = 0; // GPIO 32-48
    for (int i = 0; i < 400; i++) {
      uint32_t v = GPIO.out;
      seenHigh |= v;
      seenLow |= ~v;
      uint32_t v1 = GPIO.out1.val;
      seenHigh1 |= v1;
      seenLow1 |= ~v1;
      delayMicroseconds(20);
    }
    JsonDocument d;
    for (auto &p : PINS) {
      uint32_t hi = (p.gpio < 32) ? seenHigh : seenHigh1;
      uint32_t lo = (p.gpio < 32) ? seenLow : seenLow1;
      uint32_t m = 1UL << (p.gpio & 31);
      const char *state = (hi & m) ? ((lo & m) ? "pulsing" : "high") : "low";
      JsonObject o = d[p.name].to<JsonObject>();
      o["gpio"] = p.gpio;
      o["state"] = state;
    }
    String out; serializeJson(d, out);
    sendJson(req, 200, out);
  });

  // IMU raw burst for characterization. Reads N samples in a tight mutex-held
  // loop (timing is real), then returns them as one JSON body. Built into a
  // capacity-reserved String (not AsyncResponseStream, whose fixed internal
  // buffer would silently truncate a ~40KB body). See docs/superpowers/specs/
  // 2026-07-18-imu-foundation-design.md.
  s_server.on("/api/imu", HTTP_GET, [](AsyncWebServerRequest *req) {
    static Tb3ImuSample burst[TB3_IMU_BURST_MAX];
    size_t n = 200;
    if (req->hasParam("n")) {
      long v = req->getParam("n")->value().toInt();
      if (v < 1) v = 1; if (v > TB3_IMU_BURST_MAX) v = TB3_IMU_BURST_MAX;
      n = (size_t)v;
    }
    Tb3ImuInfo info = tb3_imu_info();
    size_t got = info.present ? tb3_imu_burst(burst, n) : 0;
    uint32_t span = (got > 1) ? (burst[got - 1].t_us - burst[0].t_us) : 0;

    // Build into a file-static String, then stream it with a chunked filler.
    // beginResponse(String) under-transmits a large body on this AsyncTCP: it
    // sets the right Content-Length but stalls past ~4KB (measured: declared
    // 6002, sent 2734). A chunked filler drains the whole body reliably.
    s_imu_json = ""; s_imu_json.reserve(got * 128 + 256);
    char h[8], row[176];
    s_imu_json += "{\"info\":{";
    s_imu_json += info.present ? "\"present\":true," : "\"present\":false,";
    snprintf(h, sizeof(h), "0x%02X", info.mpu_who); s_imu_json += "\"mpu_who\":\""; s_imu_json += h; s_imu_json += "\",";
    snprintf(h, sizeof(h), "0x%02X", info.mag_who); s_imu_json += "\"mag_who\":\""; s_imu_json += h; s_imu_json += "\",";
    snprintf(h, sizeof(h), "0x%02X", info.bmp_id);  s_imu_json += "\"bmp_id\":\""; s_imu_json += h; s_imu_json += "\",";
    snprintf(row, sizeof(row), "\"accel_fs_g\":%u,\"gyro_fs_dps\":%u},", info.accel_fs_g, info.gyro_fs_dps); s_imu_json += row;
    snprintf(row, sizeof(row), "\"n\":%u,\"span_us\":%u,\"read_errors\":%u,\"samples\":[",
             (unsigned)got, (unsigned)span, (unsigned)(n - got)); s_imu_json += row;
    for (size_t i = 0; i < got; i++) {
      const Tb3ImuSample &s = burst[i];
      if (i) s_imu_json += ",";
      if (isnan(s.mx))
        snprintf(row, sizeof(row), "[%u,%.5f,%.5f,%.5f,%.4f,%.4f,%.4f,null,null,null,%.3f,%.3f]",
                 s.t_us, s.ax, s.ay, s.az, s.gx, s.gy, s.gz, s.tempC, s.pressHpa);
      else
        snprintf(row, sizeof(row), "[%u,%.5f,%.5f,%.5f,%.4f,%.4f,%.4f,%.3f,%.3f,%.3f,%.3f,%.3f]",
                 s.t_us, s.ax, s.ay, s.az, s.gx, s.gy, s.gz, s.mx, s.my, s.mz, s.tempC, s.pressHpa);
      s_imu_json += row;
    }
    s_imu_json += "]}";

    const size_t len = s_imu_json.length();
    AsyncWebServerResponse *r = req->beginChunkedResponse("application/json",
      [len](uint8_t *buffer, size_t maxLen, size_t index) -> size_t {
        if (index >= len) return 0;
        size_t chunk = len - index; if (chunk > maxLen) chunk = maxLen;
        memcpy(buffer, s_imu_json.c_str() + index, chunk);
        return chunk;
      });
    r->addHeader("Cache-Control", "no-store");
    req->send(r);
  });

  // Toggle a single output pin at 2Hz for `seconds` (default 10, max 60) so
  // wiring can be verified with a multimeter or LED. Pin returns to a safe
  // idle level afterwards. Only motor/camera outputs are allowed.
  s_server.addHandler(new AsyncCallbackJsonWebHandler("/api/test/pin",
    [](AsyncWebServerRequest *req, JsonVariant &json) {
      JsonVariantConst d = json.as<JsonVariantConst>();
      int gpio = d["gpio"] | -1;
      int secs = constrain((int)(d["seconds"] | 10), 1, 60);
      static const uint8_t ALLOWED[] = {5, 6, 7, 10, 12, 13, 14, 15, 16, 17, 18, 21, 38};
      bool ok = false;
      for (uint8_t p : ALLOWED) if (p == gpio) ok = true;
      if (!ok) {
        sendJson(req, 400, "{\"error\":\"gpio must be one of 5,6,7,10,12,13,14,15,16,17,18,21,38\"}");
        return;
      }
      s_pintest_gpio = (int16_t)gpio;
      s_pintest_until = millis() + (uint32_t)secs * 1000;
      char buf[80];
      snprintf(buf, sizeof(buf), "{\"ok\":true,\"gpio\":%d,\"seconds\":%d,\"hz\":2}", gpio, secs);
      sendJson(req, 200, buf);
    }));

  s_server.on("/api/stop", HTTP_POST, [](AsyncWebServerRequest *req) {
    s_joy_x = 0; s_joy_y = 0; s_joy_aux = 0; s_joy_stamp = millis();
    s_joy_stop_latched = true;   // stays centred until the client sends a centred frame
    s_stop_request = true;
    sendJson(req, 200, "{\"ok\":true,\"joy_latched\":true}");
  });

  s_server.on("/api/home", HTTP_POST, [](AsyncWebServerRequest *req) {
    if (!tb3_goto_safe()) { sendJson(req, 409, "{\"error\":\"busy\"}"); return; }
    s_home_request = true;
    sendJson(req, 202, "{\"ok\":true}");
  });

  s_server.addHandler(new AsyncCallbackJsonWebHandler("/api/goto",
    [](AsyncWebServerRequest *req, JsonVariant &json) {
      JsonVariantConst d = json.as<JsonVariantConst>();
      float pan  = d["pan_deg"]  | (float)NAN;
      float tilt = d["tilt_deg"] | (float)NAN;
      float spd  = d["speed_dps"] | 0.0f;      // 0 => device max
      if (!(isfinite(pan) && isfinite(tilt) && fabs(pan) < 100000 && fabs(tilt) < 100000)) {
        sendJson(req, 400, "{\"error\":\"pan_deg/tilt_deg required and finite\"}");
        return;
      }
      if (!tb3_goto_safe()) {
        // tb3_goto_safe() is !Program_Engaged && motorMoving == 0, so this 409
        // has TWO causes and the old blanket "program engaged" named only one.
        // motorMoving is set by any powered axis -- a jog included -- so the
        // usual cause is simply that the rig is still decelerating (~450ms from
        // full jog rate). Reporting that as "program engaged" sent every reader
        // hunting the wrong fault; say which one it actually is.
        Tb3Status st = tb3_get_status();
        sendJson(req, 409, st.program_engaged
          ? "{\"error\":\"busy - program engaged\"}"
          : "{\"error\":\"busy - motors still moving; retry once status moving==0\"}");
        return;
      }
      s_goto_pan_deg = pan; s_goto_tilt_deg = tilt; s_goto_speed_dps = spd;
      s_goto_request = true;
      sendJson(req, 202, "{\"ok\":true}");
    }));

  s_server.addHandler(new AsyncCallbackJsonWebHandler("/api/joy",
    [](AsyncWebServerRequest *req, JsonVariant &json) {
      applyInputCommand(json.as<JsonVariantConst>());
      sendJson(req, 200, "{\"ok\":true}");
    }));

  s_server.addHandler(new AsyncCallbackJsonWebHandler("/api/button",
    [](AsyncWebServerRequest *req, JsonVariant &json) {
      JsonVariantConst d = json.as<JsonVariantConst>();
      uint32_t ms = constrain((int)(d["ms"] | 300), 30, 2000);
      const char *b = d["button"] | (const char *)(d["b"] | "");
      bool ok = true;
      if (!strcmp(b, "c")) s_btn_c_until = millis() + ms;
      else if (!strcmp(b, "z")) s_btn_z_until = millis() + ms;
      else ok = false;
      sendJson(req, ok ? 200 : 400,
               ok ? "{\"ok\":true}" : "{\"error\":\"button must be c or z\"}");
    }));

  s_server.addHandler(new AsyncCallbackJsonWebHandler("/api/camera",
    [](AsyncWebServerRequest *req, JsonVariant &json) {
      JsonVariantConst d = json.as<JsonVariantConst>();
      const char *action = d["action"] | "";
      uint32_t ms = constrain((int)(d["ms"] | 150), 30, 30000);
      bool ok = true;
      if (!strcmp(action, "shoot")) {
        s_cam_focus_until = s_cam_shutter_until = millis() + ms;
      } else if (!strcmp(action, "focus")) {
        s_cam_focus_until = millis() + ms;
      } else ok = false;
      sendJson(req, ok ? 200 : 400,
               ok ? "{\"ok\":true}" : "{\"error\":\"action must be shoot or focus\"}");
    }));

  s_server.on("/api/wifi", HTTP_GET, [](AsyncWebServerRequest *req) {
    JsonDocument d;
    d["ssid"] = s_prefs.isKey("ssid") ? s_prefs.getString("ssid", "") : String();
    d["sta_ip"] = (WiFi.status() == WL_CONNECTED) ? WiFi.localIP().toString() : "";
    String out; serializeJson(d, out);
    sendJson(req, 200, out);
  });

  s_server.addHandler(new AsyncCallbackJsonWebHandler("/api/wifi",
    [](AsyncWebServerRequest *req, JsonVariant &json) {
      JsonVariantConst d = json.as<JsonVariantConst>();
      s_prefs.putString("ssid", (const char *)(d["ssid"] | ""));
      s_prefs.putString("pass", (const char *)(d["pass"] | ""));
      s_wifi_reconnect = true;
      sendJson(req, 200, "{\"ok\":true}");
    }));

  // Indexed BY progtype (the #defines in TB3_Black_109_Release1.ino), so the
  // order is load-bearing and new entries append. tb3_program_count() is the
  // authority on how many are valid - emit that many so an entry added to the
  // menu can never silently vanish from the picker, named or not.
  static const char *PROGRAM_NAMES[] = {
    "New 2-Pt Move", "Rev 2-Pt Move", "New 3-Pt Move", "Rev 3-Pt Move",
    "Panorama", "Portrait Pano", "DF Slave", "Setup Menu", "Track (Web)"
  };
  static const int PROGRAM_NAMES_N = (int)(sizeof(PROGRAM_NAMES) / sizeof(PROGRAM_NAMES[0]));

  s_server.on("/api/program", HTTP_GET, [](AsyncWebServerRequest *req) {
    JsonDocument d;
    d["current"] = tb3_program_current();
    d["selectable"] = tb3_program_selectable();
    JsonArray names = d["names"].to<JsonArray>();
    for (int i = 0; i < tb3_program_count(); i++)
      names.add(i < PROGRAM_NAMES_N ? PROGRAM_NAMES[i] : "?");
    String out; serializeJson(d, out);
    sendJson(req, 200, out);
  });

  s_server.addHandler(new AsyncCallbackJsonWebHandler("/api/program",
    [](AsyncWebServerRequest *req, JsonVariant &json) {
      JsonVariantConst d = json.as<JsonVariantConst>();
      int type = d["type"] | -1;
      bool select = d["select"] | false;
      // Bound and error text both derived from the menu table. This guard runs
      // BEFORE tb3_program_set_type(), so a literal here silently overrides the
      // bound that function enforces - a hardcoded "0..7" is what kept WEBTRACK
      // (8) unreachable from the picker after MENU_OPTIONS grew to 9.
      const int last = tb3_program_count() - 1;
      if (type < 0 || type > last) {
        char err[48];
        snprintf(err, sizeof(err), "{\"error\":\"type must be 0..%d\"}", last);
        sendJson(req, 400, err);
        return;
      }
      if (!tb3_program_selectable()) {
        sendJson(req, 409, "{\"error\":\"not at the program menu\"}");
        return;
      }
      tb3_program_set_type(type);
      if (select) s_btn_c_until = millis() + 80;  // virtual C-press commits it
      sendJson(req, 200, "{\"ok\":true}");
    }));

  s_ws.onEvent([](AsyncWebSocket *, AsyncWebSocketClient *client,
                  AwsEventType type, void *arg, uint8_t *data, size_t len) {
    if (type != WS_EVT_DATA) return;
    AwsFrameInfo *info = (AwsFrameInfo *)arg;
    if (!info->final || info->opcode != WS_TEXT || len > 200) return;
    JsonDocument d;
    if (deserializeJson(d, data, len) == DeserializationError::Ok) {
      applyInputCommand(d.as<JsonVariantConst>());
    }
  });
  s_server.addHandler(&s_ws);

  s_server.onNotFound([](AsyncWebServerRequest *req) {
    sendJson(req, 404, "{\"error\":\"not found\"}");
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
void tb3_web_begin() {
  s_prefs.begin("tb3", false);

  WiFi.mode(WIFI_AP_STA);
  // 10.31.31.x: the ESP32 default AP subnet (192.168.4.x) is a common home
  // LAN range and collides when the device also joins such a LAN over STA.
  WiFi.softAPConfig(IPAddress(10, 31, 31, 1), IPAddress(10, 31, 31, 1),
                    IPAddress(255, 255, 255, 0));
  WiFi.softAP(AP_SSID, AP_PASS);
  String ssid = s_prefs.isKey("ssid") ? s_prefs.getString("ssid", "") : String();
  if (ssid.length()) {
    WiFi.begin(ssid.c_str(), s_prefs.getString("pass", "").c_str());
  }

  setupRoutes();
  tb3_ota_setup_web(s_server);
  tb3_ota_begin_espota();
  s_server.begin();

  xTaskCreatePinnedToCore(telemetryTask, "tb3_telemetry", 6144, nullptr, 1,
                          nullptr, 0);

  Serial.print("[web] SoftAP \"");
  Serial.print(AP_SSID);
  Serial.print("\" up at http://");
  Serial.println(WiFi.softAPIP());
}

// Called from tb3_goto_execute()'s blocking move loop so /api/stop still lands.
void tb3_web_pump_during_move() {
  if (s_stop_request) {
    s_stop_request = false;
    tb3_request_stop();   // sets hardStopRequested; updateMotorVelocities() decelerates
  }
}

void tb3_web_poll() {
  uint32_t now = millis();

  // joystick with deadman
  if (now - s_joy_stamp < JOY_DEADMAN_MS) {
    if (s_joy_stop_latched) {
      // Held at centre until the client lets go. Scoped inside the deadman window
      // on purpose: once the web client goes quiet the deadman centres things
      // anyway, and staying out of g_usb_* here means a latched web client cannot
      // stomp a physical gamepad that shares the same virtual axes.
      g_usb_joy_x = (uint8_t)joy_x_axis_Offset;
      g_usb_joy_y = (uint8_t)joy_y_axis_Offset;
      g_usb_accel_x = (uint16_t)accel_x_axis_Offset;
    } else {
      g_usb_joy_x = (uint8_t)(joy_x_axis_Offset + s_joy_x);
      g_usb_joy_y = (uint8_t)(joy_y_axis_Offset + s_joy_y);
      g_usb_accel_x = (uint16_t)(accel_x_axis_Offset + (int)s_joy_aux * 2);
    }
  }

  // timed button presses (the input path re-centers every cycle, so holding
  // just means the deadline is still in the future)
  if (now < s_btn_c_until) g_usb_button_c = true;
  if (now < s_btn_z_until) g_usb_button_z = true;

  // manual camera trigger; leave the pins alone when a program shot runs
  bool wantShutter = now < s_cam_shutter_until;
  bool wantFocus = now < s_cam_focus_until;
  bool wantActive = wantShutter || wantFocus;
  if (wantActive || s_cam_active) {
    if (!tb3_get_status().shutter_engaged) {
      tb3_cam_write(wantShutter, wantFocus);
    }
    s_cam_active = wantActive;
  }

  if (s_stop_request) {
    s_stop_request = false;
    tb3_request_stop();
  }

  if (s_home_request) {
    s_home_request = false;
    if (tb3_goto_safe()) tb3_set_home();
  }

  if (s_goto_request) {
    s_goto_request = false;
    s_stop_request = false;   // drop any stale stop so it can't abort the fresh move
    if (tb3_goto_safe()) tb3_goto_execute(s_goto_pan_deg, s_goto_tilt_deg, s_goto_speed_dps);
  }

  // wiring pin test: 2Hz square wave, then restore a safe idle level
  if (s_pintest_gpio >= 0) {
    int16_t pin = s_pintest_gpio;
    if (now < s_pintest_until) {
      digitalWrite(pin, ((now / 250) & 1) ? HIGH : LOW);
    } else {
      // enables idle disabled (HIGH); microstep pins idle HIGH; rest LOW
      bool idleHigh = (pin >= 13 && pin <= 17);
      digitalWrite(pin, idleHigh ? HIGH : LOW);
      s_pintest_gpio = -1;
    }
  }

  if (s_wifi_reconnect) {
    s_wifi_reconnect = false;
    s_mdns_up = false;
    WiFi.disconnect();
    String ssid = s_prefs.isKey("ssid") ? s_prefs.getString("ssid", "") : String();
    if (ssid.length()) {
      WiFi.begin(ssid.c_str(), s_prefs.getString("pass", "").c_str());
    }
  }
}

#endif // ESP32
