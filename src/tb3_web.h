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

struct Tb3UiState;                 // defined in tb3_lcd_pages.h
Tb3UiState tb3_ui_get_state();
void tb3_ui_write_line(uint8_t row1based, const char *text16);
void tb3_ui_repaint_status_page();

// --- program picker (Task 3) -------------------------------------------------
bool tb3_program_selectable();
int  tb3_program_current();
void tb3_program_set_type(int t);

// --- Track (Web) mode ------------------------------------------------------
// Fills a 17-byte buffer with the daemon-facing IP, centered and padded to 16.
void tb3_track_ip_line(char out[17]);

// --- OTA safety gate (Task 4, implemented in TB3_WebGlue.ino) ---------------
bool tb3_ota_safe_to_flash();
void tb3_ota_prepare();
bool tb3_ota_isr_idle();
void tb3_ota_resume();

// --- goto / home glue (drained on loopTask by tb3_web_poll) ---
bool tb3_goto_safe();     // !Program_Engaged && motorMoving == 0
void tb3_set_home();      // set_position(0,0,0)
void tb3_goto_execute(float pan_deg, float tilt_deg, float speed_dps); // absolute move, stop-interruptible
void tb3_web_pump_during_move();  // drains a pending /api/stop during a blocking move

// --- provided by tb3_gamepad ------------------------------------------------
bool tb3_gamepad_connected();
const char *tb3_gamepad_name();
bool tb3_gamepad_pairing();
void tb3_gamepad_set_pairing(bool on);
void tb3_gamepad_forget();

#endif
