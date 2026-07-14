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

#endif // ESP32
