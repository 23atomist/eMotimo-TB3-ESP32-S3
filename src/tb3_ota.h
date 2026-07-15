#ifndef TB3_OTA_H
#define TB3_OTA_H

#if defined(ESP32)
#include <ESPAsyncWebServer.h>

enum Tb3OtaState { OTA_IDLE, OTA_RUNNING, OTA_ERROR };

void         tb3_ota_setup_web(AsyncWebServer &server);  // POST/GET /api/ota
Tb3OtaState  tb3_ota_state();
int          tb3_ota_progress();       // 0..100
const char  *tb3_ota_error();

#endif // ESP32
#endif // TB3_OTA_H
