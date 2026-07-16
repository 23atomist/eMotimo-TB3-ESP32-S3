/*
  Glue between the web/gamepad modules (plain .cpp) and firmware state that
  only exists in the concatenated .ino unit (types, pin macros, globals).
*/

#if defined(ESP32)

// Original TB3 battery sense: 51 ADC counts per volt on a 10-bit/5V AVR ADC,
// i.e. the divider puts ~0.2493 x battery volts on the ADC pin. Same divider
// on the ESP32-S3 12-bit/3.3V ADC gives volts = raw * 3.3 / 4095 / 0.2493.
#define TB3_BATT_VOLTS_PER_COUNT 0.003232f

Tb3Status tb3_get_status()
{
  Tb3Status st;
  st.pan = current_steps.x;
  st.tilt = current_steps.y;
  st.aux = current_steps.z;
  st.moving = motorMoving;
  st.progstep = progstep;
  st.progtype = progtype;
  st.camera_fired = camera_fired;
  st.camera_total = camera_total_shots;
  st.interval_mode = intval;
  st.program_engaged = Program_Engaged;
  st.shutter_engaged = Shutter_Signal_Engaged;
  st.battery_v = analogRead(A0) * TB3_BATT_VOLTS_PER_COUNT;
  return st;
}

void tb3_get_lcd(char *line1, char *line2)
{
  lcd.getShadow(line1, line2);
}

void tb3_request_stop()
{
  g_usb_joy_x = (uint8_t)joy_x_axis_Offset;
  g_usb_joy_y = (uint8_t)joy_y_axis_Offset;
  g_usb_accel_x = (uint16_t)accel_x_axis_Offset;
  g_usb_button_c = false;
  g_usb_button_z = false;
  hardStopRequested = true; // consumed by updateMotorVelocities()
}

void tb3_cam_write(bool shutter, bool focus)
{
  digitalWrite(CAMERA_PIN, shutter ? HIGH : LOW);
  digitalWrite(FOCUS_PIN, focus ? HIGH : LOW);
}

#include "tb3_lcd_pages.h"
#include <WiFi.h>

// STEPS_PER_DEG is defined in the main .ino; recompute degrees here so the
// pure formatter stays Arduino-free.
Tb3UiState tb3_ui_get_state()
{
  Tb3UiState s{};
  s.sta_connected = (WiFi.status() == WL_CONNECTED);
  snprintf(s.ap_ip, sizeof(s.ap_ip), "%s", WiFi.softAPIP().toString().c_str());
  if (s.sta_connected)
    snprintf(s.sta_ip, sizeof(s.sta_ip), "%s", WiFi.localIP().toString().c_str());
  else
    s.sta_ip[0] = 0;
  s.progtype       = (uint16_t)progtype;
  s.progstep       = (uint16_t)progstep;
  s.phase2pt       = (uint16_t)program_progress_2PT;
  s.phase3pt       = (uint16_t)program_progress_3PT;
  s.interval_mode  = (uint16_t)intval;
  s.pan_deg        = current_steps.x / STEPS_PER_DEG;
  s.tilt_deg       = current_steps.y / STEPS_PER_DEG;
  return s;
}

// Writes exactly the given text at (row,1). row1based is 1 or 2.
void tb3_ui_write_line(uint8_t row1based, const char *text16)
{
  lcd.at(row1based, 1, text16);
}

void tb3_ui_repaint_status_page()
{
  first_time = 1;      // force display_status() to repaint the full skeleton
  display_status();
}

bool tb3_program_selectable()
{
  switch (progstep) {
    case 0: case 100: case 200: case 210: case 300: return true;
    default: return false;
  }
}

int tb3_program_current() { return (int)progtype; }

void tb3_program_set_type(int t)
{
  if (t < 0 || t > 7) return;
  progtype = (unsigned int)t;
  first_time = 1;   // force the menu to redraw the new selection
}

bool tb3_ota_safe_to_flash()
{
  return !Program_Engaged && motorMoving == 0;
}

void tb3_ota_prepare()
{
  stopISR1();        // halt the 40kHz step ISR before flash writes
  disable_PT();
  disable_AUX();
}

bool tb3_ota_isr_idle() { return !motor_timer_running; }

void tb3_ota_resume() { startISR1(); }   // restart the free-running step engine after a failed OTA

// ---- goto / home ----------------------------------------------------------
bool tb3_goto_safe()
{
  return !Program_Engaged && motorMoving == 0;
}

void tb3_set_home()
{
  set_position(0.0, 0.0, 0.0);   // zero the software origin; no motion
}

void tb3_goto_execute(float pan_deg, float tilt_deg, float speed_dps)
{
  float tx = pan_deg * STEPS_PER_DEG;
  float ty = tilt_deg * STEPS_PER_DEG;
  float tz = current_steps.z;              // goto controls pan/tilt; hold aux

  enable_PT();
  enable_AUX();

  if (speed_dps > 0.0) {
    float dist_deg = max(fabs(pan_deg  - current_steps.x / STEPS_PER_DEG),
                         fabs(tilt_deg - current_steps.y / STEPS_PER_DEG));
    float move_time = dist_deg / speed_dps;          // seconds
    if (move_time < 0.05) synched3PtMove_max(tx, ty, tz);
    else                  synched3AxisMove_timed(tx, ty, tz, move_time, 0.2);
  } else {
    synched3PtMove_max(tx, ty, tz);
  }

  startISR1();
  do {
    if (!nextMoveLoaded) updateMotorVelocities();
    tb3_web_pump_during_move();            // lets /api/stop break us out
  } while (motorMoving);
  stopISR1();
}

#endif // ESP32
