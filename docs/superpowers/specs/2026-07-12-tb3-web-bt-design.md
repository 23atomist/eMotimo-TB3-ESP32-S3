# TB3 Black ESP32-S3: Web API, Web UI, and Bluetooth Gamepad — Design

Date: 2026-07-12
Status: implemented same day; user review pending

## Goal

The eMotimo TB3 Black (3-axis timelapse head) now runs on an ESP32-S3 DevKitC-1
(N16R8). After fixing the DFMoco ISR port (see git history / memory), add:

- **(b)** a full web API,
- **(c)** a self-contained web interface driving that API,
- **(d)** Bluetooth gamepad pairing that works independently of the web UI
  (replaces the wired Wii Nunchuck).

## Constraints and context

- The 2015 firmware is a large *blocking* state machine: `loop()` switches on
  `progstep`, and most menus/moves sit in nested `while` loops that poll the
  joystick. A full async rewrite is out of scope and high-risk.
- The joystick was already virtualized during the ESP32 port:
  `volatile uint8_t g_usb_joy_x, g_usb_joy_y; volatile uint16_t g_usb_accel_x;
  volatile bool g_usb_button_c, g_usb_button_z;` feed the old Nunchuck read
  path (`TB3_Nunchuck.ino`). Anything that writes those variables can drive
  the whole firmware, even inside nested menu loops.
- ESP32-S3 is **BLE-only** (no BT Classic): supported pads are Xbox Series
  X|S (BLE firmware), 8BitDo in BLE mode, Stadia (BLE mode), and other BLE HID
  gamepads. PS4/PS5/Switch pads are BT Classic and will NOT pair with an S3.
- The 16x2 serial LCD (NHDLCD9 over Serial1/GPIO4) is the only display; the
  web UI mirrors it so remote users see exactly what the device shows.

## Approaches considered

1. **Virtual-input injection + LCD mirror + direct API for telemetry/jog**
   *(chosen)* — web and BT inputs write the existing virtual joystick
   variables; a shadow buffer in NHDLCD9 mirrors the screen to the browser.
   Full existing functionality (menus, 2pt/3pt programs, pano, DF slave)
   becomes remotely drivable with zero changes to the state machine.
2. Direct REST control of program parameters (write `camera_moving_shots`,
   `motor_steps_pt[]`, force `progstep` transitions) — rejected for v1: the
   state machine assumes menu-order side effects; forcing transitions from an
   async task invites corrupt program state. Can be layered on later.
3. Full async rewrite of the state machine — rejected: weeks of effort, high
   regression risk on shipped hardware.

## Architecture

New/changed units:

- `src/tb3_web.h` / `src/tb3_web.cpp` — WiFi (SoftAP `TB3-Black`, WPA2 pass
  `tb3black109`, IP 10.31.31.1; optional STA join stored in NVS
  Preferences), ESPAsyncWebServer on :80, REST API under `/api/`, WebSocket
  at `/ws`, 5 Hz telemetry pump (FreeRTOS task on core 0). Serves the UI from
  PROGMEM.
- `src/tb3_ui.h` — the single-file web app (vanilla HTML/CSS/JS, no external
  resources) as a PROGMEM string.
- `src/tb3_gamepad.h` / `src/tb3_gamepad.cpp` — BLE gamepad host via
  `tbekas/BLE-Gamepad-Client` (NimBLE-based, works with the stock pioarduino
  Arduino framework; Bluepad32 was rejected because it requires either the
  Arduino-IDE board package or an ESP-IDF project, neither of which can build
  this .ino codebase). Supports Xbox One/Series pads over BLE (and Steam
  Controller, not wired up in v1). Maps left stick X/Y to pan/tilt, right
  stick X (or dpad) to AUX, A→C button, B→Z button. The library auto-scans
  whenever no pad is connected, so device-side pairing is always available;
  API `forget` clears BLE bonds.
- `NHDLCD9` — gains a 2x16 shadow buffer + brightness mirror; every write to
  the panel also updates the shadow. Getter used by telemetry.
- `TB3_Nunchuck.ino` — `NunChuckRequestData()` additionally calls
  `tb3_gamepad_poll()` and `tb3_web_poll()` each cycle, so BT/web input and
  deadman timeouts work inside every blocking loop.
- Input arbitration: sources write the same virtual variables; last writer
  wins. Web joystick input expires after 750 ms without refresh (deadman →
  auto-center); gamepad input is applied only while a pad is connected and
  its values are away from center OR changed (so an idle pad does not fight
  the web joystick).

### REST API (v1)

| Method/Path | Body / Response |
|---|---|
| GET `/api/status` | `{pos:{pan,tilt,aux}, moving, progstep, progtype, camera_fired, camera_total, interval_mode, battery_v, uptime_ms, heap, wifi:{ap_ip,sta_ip,clients}, bt:{connected,name,pairing}}` |
| GET `/api/lcd` | `{line1, line2}` |
| POST `/api/joy` | `{x:-100..100, y:-100..100, aux:-100..100}` → virtual stick (deadman 750 ms) |
| POST `/api/button` | `{button:"c"\|"z", ms:50..2000}` → timed virtual press |
| POST `/api/camera` | `{action:"shoot"\|"focus", ms}` → fires opto outputs directly |
| POST `/api/stop` | zeroes virtual inputs, requests DF hard stop |
| GET `/api/bt` | `{connected, name, pairing}` |
| POST `/api/bt` | `{pairing:true\|false}` or `{forget:true}` |
| GET `/api/wifi` / POST `/api/wifi` | read / store STA credentials (NVS), `{ssid,pass}`; empty ssid clears |
| GET `/api/info` | firmware/build info |

WebSocket `/ws`: server pushes `{type:"tick", lcd:[l1,l2], pos, moving, camera_fired, battery_v, bt}` at 5 Hz; accepts the same JSON as `/api/joy`/`/api/button` for low-latency control.

### Web UI

Single dark-theme mobile-first page: live LCD mirror (green 16x2), virtual
thumbstick (pointer events, spring-to-center, sends via WS at 10 Hz while
touched), AUX slider, C/Z buttons, position/battery/status readouts, camera
fire/focus, BT pairing toggle + connected pad name, STA WiFi form. No
external assets; works from `http://10.31.31.1/`.

### Error handling

- Web/BT input never bypasses the firmware's own limits (it goes through the
  same joystick path with its accel/speed clamps).
- Deadman on web joystick; BT disconnect auto-centers the virtual stick.
- API validates ranges; out-of-range → 400 with JSON error.
- WS clients capped (cleanupClients + hard cap 4), oversized frames ignored.
- AsyncWebServer handlers only touch volatile scalars or queue flags — no
  blocking calls, no LCD/EEPROM access from the network task.

### Testing

- Build + flash; serial log asserts: AP up, server up, BP32 initialized.
- `curl` API checks from the Mac if a free WLAN interface can join the AP;
  otherwise manual smoke-test steps documented in the summary.
- Motor-path regression: the ISR fix test (fake move, step count) was
  verified before this feature work; jog via `/api/joy` exercises the same
  path end-to-end.

## Out of scope (v1)

- Direct program-parameter API (approach 2) — future layer.
- OTA updates, HTTPS/auth (AP is local and WPA2-protected), multi-client
  input arbitration beyond last-write-wins.
