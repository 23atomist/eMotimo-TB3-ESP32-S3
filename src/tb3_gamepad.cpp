#if defined(ESP32)

#include <Arduino.h>
#include <BLEGamepadClient.h>
#include <NimBLEDevice.h>
#include "tb3_gamepad.h"

extern volatile uint8_t g_usb_joy_x;
extern volatile uint8_t g_usb_joy_y;
extern volatile uint16_t g_usb_accel_x;
extern volatile bool g_usb_button_c;
extern volatile bool g_usb_button_z;
extern int joy_x_axis_Offset;
extern int joy_y_axis_Offset;
extern int accel_x_axis_Offset;

static XboxController s_xbox;
static volatile bool s_connected = false;

static const float STICK_DEADZONE = 0.08f;
static const uint32_t POLL_MS = 10;

void tb3_gamepad_begin() {
  // init(false): keep BLE bonds across power cycles (the library default
  // wipes them on every boot, forcing re-pairing in the field)
  BLEGamepadClient::init(false);
  s_xbox.onConnected([](XboxController &) {
    s_connected = true;
    Serial.println("[bt] gamepad connected");
  });
  s_xbox.onDisconnected([](XboxController &) {
    s_connected = false;
    Serial.println("[bt] gamepad disconnected");
  });
  s_xbox.begin();
  Serial.println("[bt] BLE gamepad host ready (Xbox One/Series over BLE)");
}

void tb3_gamepad_poll() {
  static uint32_t last = 0;
  uint32_t now = millis();
  if (now - last < POLL_MS) return;
  last = now;

  if (!s_connected || !s_xbox.isConnected()) return;

  XboxControlsState st;
  s_xbox.read(&st);

  float x = st.leftStickX;
  float y = st.leftStickY; // positive = up, same convention as the virtual joy
  float rx = st.rightStickX;
  if (fabsf(x) < STICK_DEADZONE) x = 0;
  if (fabsf(y) < STICK_DEADZONE) y = 0;
  if (fabsf(rx) < STICK_DEADZONE) rx = 0;

  // dpad = full-deflection digital control
  if (st.dpadLeft) x = -1.0f;
  if (st.dpadRight) x = 1.0f;
  if (st.dpadUp) y = 1.0f;
  if (st.dpadDown) y = -1.0f;

  bool active = x != 0 || y != 0 || rx != 0 || st.buttonA || st.buttonB;
  if (!active) return; // idle pad leaves the virtual inputs alone

  g_usb_joy_x = (uint8_t)(joy_x_axis_Offset + (int)(x * 100.0f));
  g_usb_joy_y = (uint8_t)(joy_y_axis_Offset + (int)(y * 100.0f));
  g_usb_accel_x = (uint16_t)(accel_x_axis_Offset + (int)(rx * 200.0f));
  if (st.buttonA) g_usb_button_c = true;
  if (st.buttonB) g_usb_button_z = true;
}

bool tb3_gamepad_connected() { return s_connected; }

const char *tb3_gamepad_name() {
  return s_connected ? "Xbox Wireless Controller" : "";
}

// The library auto-scans for supported controllers whenever none is
// connected, so "pairing mode" on the device side is always available;
// put the controller itself into pairing mode to connect it.
bool tb3_gamepad_pairing() { return !s_connected; }

void tb3_gamepad_set_pairing(bool) {}

void tb3_gamepad_forget() {
  NimBLEDevice::deleteAllBonds();
  Serial.println("[bt] bluetooth bonds cleared");
}

#endif // ESP32
