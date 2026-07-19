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

// LCD hardware is gone; the web status/telemetry endpoint still reads this
// (tb3_web.cpp), so keep the signature and return empty strings.
void tb3_get_lcd(char *line1, char *line2)
{
  line1[0] = 0;
  line2[0] = 0;
}

void tb3_request_stop()
{
  g_usb_joy_x = (uint8_t)joy_x_axis_Offset;
  g_usb_joy_y = (uint8_t)joy_y_axis_Offset;
  g_usb_accel_x = (uint16_t)accel_x_axis_Offset;
  g_usb_button_c = false;
  g_usb_button_z = false;
  // hardStopRequested is consumed only by updateMotorVelocities(), which runs
  // only while a move executes. Setting it with no active move leaves a lingering
  // flag that the NEXT move's first velocity update would consume, hardStop()-ing
  // the fresh move before it moves. Only request a hard stop when there is one.
  if (motorMoving) hardStopRequested = true;
}

void tb3_cam_write(bool shutter, bool focus)
{
  digitalWrite(CAMERA_PIN, shutter ? HIGH : LOW);
  digitalWrite(FOCUS_PIN, focus ? HIGH : LOW);
}

#include <WiFi.h>

// Space-pad (or truncate) src to exactly 16 chars + NUL in out[17]. Relocated
// from the deleted tb3_lcd_pages.cpp: the LCD is gone, but tb3_track_ip_line()
// below still needs this pure formatter to build the (no-longer-displayed,
// still tracked) IP string.
static void tb3_pad16(char out[17], const char *src) {
  size_t n = strlen(src);
  if (n > 16) n = 16;
  memcpy(out, src, n);
  for (size_t i = n; i < 16; i++) out[i] = ' ';
  out[16] = 0;
}

void tb3_fmt_ip_centered(char out[17], const char *ip) {
  char tmp[17];
  size_t n = strlen(ip);
  if (n >= 16) { tb3_pad16(out, ip); return; }   // >=16 truncates via tb3_pad16
  size_t left = (16 - n) / 2;
  size_t k = 0;
  for (size_t i = 0; i < left; i++) tmp[k++] = ' ';
  memcpy(tmp + k, ip, n); k += n;
  tmp[k] = 0;
  tb3_pad16(out, tmp);
}

// Second line of the Track (Web) screen: the address the layer-3 daemon talks
// to. Prefer the STA IP; fall back to the SoftAP IP when the rig has not joined
// a network, since that is still a working address (just on the rig's own AP)
// and a blank line would tell the operator nothing.
void tb3_track_ip_line(char out[17])
{
  if (WiFi.status() == WL_CONNECTED)
    tb3_fmt_ip_centered(out, WiFi.localIP().toString().c_str());
  else
    tb3_fmt_ip_centered(out, WiFi.softAPIP().toString().c_str());
}

bool tb3_program_selectable()
{
  switch (progstep) {
    case 0: case 100: case 200: case 210: case 300: return true;
    default: return false;
  }
}

int tb3_program_current() { return (int)progtype; }

// How many menu entries exist. MENU_OPTIONS is a macro in the .ino unit and so
// is invisible to tb3_web.cpp; without this the HTTP layer has to keep its own
// copy of the range, which is precisely how WEBTRACK ended up rejected by a
// hardcoded "0..7" guard that ran before tb3_program_set_type() could bound it.
int tb3_program_count() { return MENU_OPTIONS; }

void tb3_program_set_type(int t)
{
  // Bound by the menu table, not a literal, so adding a program (WEBTRACK) does
  // not silently leave the web picker unable to reach the new last entry.
  if (t < 0 || t > (MENU_OPTIONS - 1)) return;
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
  // Start from a clean stop-state. hardStopRequested is consumed only inside this
  // blocking loop; a /api/stop fired while idle is drained by tb3_web_poll() into
  // hardStopRequested and then lingers with nothing to consume it. Without this
  // clear, the fresh move's first updateMotorVelocities() would see the stale flag
  // and hardStop() the move before it starts (position never leaves the origin).
  hardStopRequested = false;

  // A web goto can run from a cold-boot menu screen where DFSetup() never ran,
  // leaving EVERY motor motion parameter at 0. Both move planners then divide by
  // those zeros: calculatePointToPoint_jog does tmax = maxVelocity/maxAcceleration
  // and calculateVelocityMotor clamps moveMaxVelocity to jogMaxVelocity (=0), so
  // calculatePointToPoint_move does tmax = moveMaxVelocity/moveMaxAcceleration =
  // 0/0 = NaN. NaN move segments make the ISR fire but never step (no motion) and
  // the move never completes (NaN != 0), hanging the blocking loop. Initialize the
  // point-to-point AND jog limits exactly as DFSetup() does so the goto is
  // independent of screen state.
  // 10000 sps == 22.5 deg/s: the hardware jog ceiling (PAN/TILT_MAX_JOG_STEPS_PER_SEC),
  // a manufacturer-proven speed the jog screens already use. This is also the
  // moveMaxVelocity ceiling calculateVelocityMotor() clamps timed moves to.
  for (int i = 0; i < 3; i++) setPulsesPerSecond(i, 10000);  // maxVelocity/maxAcceleration
  motors[0].jogMaxVelocity = PAN_MAX_JOG_STEPS_PER_SEC;
  motors[0].jogMaxAcceleration = PAN_MAX_JOG_STEPS_PER_SEC / 2;
  motors[1].jogMaxVelocity = TILT_MAX_JOG_STEPS_PER_SEC;
  motors[1].jogMaxAcceleration = TILT_MAX_JOG_STEPS_PER_SEC / 2;
  motors[2].jogMaxVelocity = AUX_MAX_JOG_STEPS_PER_SEC;
  motors[2].jogMaxAcceleration = AUX_MAX_JOG_STEPS_PER_SEC / 2;

  float tx = pan_deg * STEPS_PER_DEG;
  float ty = tilt_deg * STEPS_PER_DEG;
  float tz = current_steps.z;              // goto controls pan/tilt; hold aux

  enable_PT();
  enable_AUX();

  float dist_deg = max(fabs(pan_deg  - current_steps.x / STEPS_PER_DEG),
                       fabs(tilt_deg - current_steps.y / STEPS_PER_DEG));

  // Expected move duration, used only to size the watchdog below. A timed move
  // runs in ~move_time; a max-speed move runs at the P2P ceiling of 10000 sps
  // (== 10000 / STEPS_PER_DEG deg/s).
  float expected_s;
  if (speed_dps > 0.0) {
    float move_time = dist_deg / speed_dps;          // seconds
    expected_s = move_time;
    if (move_time < 0.05) synched3PtMove_max(tx, ty, tz);
    else                  synched3AxisMove_timed(tx, ty, tz, move_time, 0.2);
  } else {
    expected_s = dist_deg / (10000.0f / STEPS_PER_DEG);
    synched3PtMove_max(tx, ty, tz);
  }

  // Watchdog: a goto must NEVER permanently wedge loopTask (e.g. some future
  // regression that keeps a move from completing). Bound the blocking loop at a
  // generous multiple of the planned duration so a legitimate long move is never
  // cut short, while a genuine hang still aborts cleanly back to idle.
  uint32_t timeout_ms = (uint32_t)(expected_s * 3000.0f) + 4000;   // 3x + 4s margin

  startISR1();
  uint32_t t0 = millis();
  do {
    if (!nextMoveLoaded) updateMotorVelocities();
    tb3_web_pump_during_move();            // lets /api/stop break us out
    if (millis() - t0 > timeout_ms) { motorMoving = 0; break; }
  } while (motorMoving);
  stopISR1();
}

#endif // ESP32
