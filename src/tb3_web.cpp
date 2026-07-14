#if defined(ESP32)

#include "tb3_web.h"
#include "tb3_ui.h"

#include <WiFi.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <AsyncJson.h>
#include <ArduinoJson.h>
#include "soc/gpio_struct.h"

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
static volatile uint32_t s_btn_c_until = 0;
static volatile uint32_t s_btn_z_until = 0;
static volatile uint32_t s_cam_shutter_until = 0;
static volatile uint32_t s_cam_focus_until = 0;
static volatile bool s_stop_request = false;
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
  char btn[36];
  jsonEscapeInto(btn, sizeof(btn), tb3_gamepad_name());
  char sta[20] = "";
  if (WiFi.status() == WL_CONNECTED) {
    snprintf(sta, sizeof(sta), "%s", WiFi.localIP().toString().c_str());
  }
  return snprintf(buf, len,
    "{\"type\":\"tick\",\"lcd\":[\"%s\",\"%s\"],\"pos\":[%.0f,%.0f,%.0f],"
    "\"moving\":%u,\"prog\":%d,\"fired\":%u,\"total\":%u,\"batt\":%.2f,"
    "\"bt\":{\"c\":%d,\"n\":\"%s\",\"p\":%d},\"sta\":\"%s\"}",
    e1, e2, st.pan, st.tilt, st.aux,
    (unsigned)st.moving, st.program_engaged ? 1 : 0,
    st.camera_fired, st.camera_total, st.battery_v,
    tb3_gamepad_connected() ? 1 : 0, btn, tb3_gamepad_pairing() ? 1 : 0, sta);
}

// ---------------------------------------------------------------------------
// Telemetry task (core 0): 5 Hz push to all WS clients
// ---------------------------------------------------------------------------
static void telemetryTask(void *) {
  char buf[400];
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(200));
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
    JsonObject bt = d["bt"].to<JsonObject>();
    bt["connected"] = tb3_gamepad_connected();
    bt["name"] = tb3_gamepad_name();
    bt["pairing"] = tb3_gamepad_pairing();
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

  s_server.on("/api/bt", HTTP_GET, [](AsyncWebServerRequest *req) {
    JsonDocument d;
    d["connected"] = tb3_gamepad_connected();
    d["name"] = tb3_gamepad_name();
    d["pairing"] = tb3_gamepad_pairing();
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
    s_stop_request = true;
    sendJson(req, 200, "{\"ok\":true}");
  });

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

  s_server.addHandler(new AsyncCallbackJsonWebHandler("/api/bt",
    [](AsyncWebServerRequest *req, JsonVariant &json) {
      JsonVariantConst d = json.as<JsonVariantConst>();
      if (d["forget"] | false) tb3_gamepad_forget();
      if (d["pairing"].is<bool>()) tb3_gamepad_set_pairing(d["pairing"]);
      sendJson(req, 200, "{\"ok\":true}");
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
  s_server.begin();

  xTaskCreatePinnedToCore(telemetryTask, "tb3_telemetry", 6144, nullptr, 1,
                          nullptr, 0);

  Serial.print("[web] SoftAP \"");
  Serial.print(AP_SSID);
  Serial.print("\" up at http://");
  Serial.println(WiFi.softAPIP());
}

void tb3_web_poll() {
  uint32_t now = millis();

  // joystick with deadman
  if (now - s_joy_stamp < JOY_DEADMAN_MS) {
    g_usb_joy_x = (uint8_t)(joy_x_axis_Offset + s_joy_x);
    g_usb_joy_y = (uint8_t)(joy_y_axis_Offset + s_joy_y);
    g_usb_accel_x = (uint16_t)(accel_x_axis_Offset + (int)s_joy_aux * 2);
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
