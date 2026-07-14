#ifndef TB3_WEB_H
#define TB3_WEB_H

#include <Arduino.h>

// ---------------------------------------------------------------------------
// Web API / UI module. Runs an ESPAsyncWebServer on port 80 with a SoftAP
// (and optional STA join stored in NVS). Network handlers never block and
// never touch firmware internals directly: they write pending-input state
// that tb3_web_poll() applies from the main (loopTask) input path.
// ---------------------------------------------------------------------------

void tb3_web_begin();

// Called from NunChuckQuerywithEC() every input cycle (loopTask context).
// Applies fresh web joystick/button/camera requests to the virtual inputs,
// enforcing the deadman timeout.
void tb3_web_poll();

// --- implemented on the firmware (.ino) side -------------------------------
struct Tb3Status {
  float pan, tilt, aux;         // current_steps
  uint8_t moving;               // motorMoving bits
  unsigned progstep;
  unsigned progtype;
  unsigned camera_fired;
  unsigned camera_total;
  unsigned interval_mode;       // intval (2=video, 3=ext trig, else SMS x10)
  bool program_engaged;
  float battery_v;
  bool shutter_engaged;
};
Tb3Status tb3_get_status();
void tb3_get_lcd(char *line1, char *line2);   // 17-byte buffers
void tb3_request_stop();                       // zero inputs + DF hard stop

// --- provided by tb3_gamepad ------------------------------------------------
bool tb3_gamepad_connected();
const char *tb3_gamepad_name();
bool tb3_gamepad_pairing();
void tb3_gamepad_set_pairing(bool on);
void tb3_gamepad_forget();

#endif
