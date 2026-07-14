#ifndef TB3_GAMEPAD_H
#define TB3_GAMEPAD_H

// Bluetooth (BLE) gamepad input via Bluepad32. Pairing runs entirely
// on-device (independent of the web UI). ESP32-S3 is BLE-only: use Xbox
// Series X|S (BLE firmware), 8BitDo or Stadia pads in BLE mode, or other
// BLE HID gamepads. BT-Classic-only pads (PS4/PS5/Switch) cannot pair.
//
// Mapping: left stick = pan/tilt, right stick X (or dpad left/right when no
// right stick) = AUX, A = C button (select), B = Z button (back).

void tb3_gamepad_begin();

// Called from NunChuckQuerywithEC() each input cycle (loopTask context).
// Rate-limited internally; writes the virtual joystick only while the pad
// is actively deflected so an idle pad does not fight the web joystick.
void tb3_gamepad_poll();

#endif
