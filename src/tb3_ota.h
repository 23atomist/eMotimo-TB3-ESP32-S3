#ifndef TB3_OTA_H
#define TB3_OTA_H

#if defined(ESP32)
#include <ESPAsyncWebServer.h>

// Enumerators are TB3_-prefixed: ArduinoOTA.h defines its own unscoped
// enum with an OTA_IDLE member, which this would otherwise collide with.
enum Tb3OtaState { TB3_OTA_IDLE, TB3_OTA_RUNNING, TB3_OTA_ERROR };

void         tb3_ota_setup_web(AsyncWebServer &server);  // POST/GET /api/ota
Tb3OtaState  tb3_ota_state();
int          tb3_ota_progress();       // 0..100
const char  *tb3_ota_error();
void tb3_ota_begin_espota();   // ArduinoOTA on port 3232, hostname "tb3"

#endif // ESP32
#endif // TB3_OTA_H
