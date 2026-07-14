# TB3 Black — ESP32-S3 Firmware

eMotimo TB3 Black (3-axis timelapse motion head) firmware v109, ported to an
ESP32-S3 DevKitC-1 (N16R8) with a web API, web UI, and Bluetooth gamepad
support. Builds with PlatformIO (`pio run`), flashes over the S3's native USB
port (`pio run -t upload`).

## What was fixed in the port (2026-07-12)

The original port crash-looped with `rst:0x8 (TG1WDT_SYS_RST)`. Root causes,
all in the 40 kHz DFMoco stepper ISR, all fixed and hardware-verified:

- AVR pin-mask leftovers made the ISR call `digitalWrite(128, …)` (invalid
  GPIO) — the Arduino core's error-log path then ran `malloc()`/UART flushes
  inside the ISR → interrupt-watchdog panic. Motor-4 (a Mega debug channel)
  is now fully excluded on ESP32 (`PHYS_MOTOR_COUNT`).
- Float math in the ISR (`current_steps.x++`, `float nextMotorMoveSpeed`) —
  the Xtensa FPU is disabled in interrupts (Coprocessor exception). The ISR
  now counts steps in integers (`isr_step_delta[]`, folded back by
  `sync_isr_steps()`) and the speed field is `uint16_t` on ESP32.
- `setupstartISR1()` armed the 25 µs auto-reload alarm on an already-running
  timer — intermittent boot crash. The timer is now stopped and zeroed before
  the alarm is armed.
- `motors[].dirPin` was 0 (GPIO0) until DF-slave mode ran; now initialized at
  boot. Step/dir pins use direct GPIO register writes (`fast_gpio_write`).
- Battery sense used `analogRead(0)` (not an ADC pin on the S3) with AVR
  10-bit scaling; now reads A0/GPIO1 with 12-bit scaling.
- The jog/velocity screens ("Move to Start Pt" etc.) froze after one input
  cycle and never moved a motor: on AVR, `DFSetup()` leaves TIMER1
  free-running and the jog loops depend on the ISR clearing `nextMoveLoaded`
  every 50 ms — the ESP32 port never started the timer outside synced moves.
  `DFSetup()` now starts the free-running engine (and `startISR1`/`stopISR1`
  are idempotent). Verified on hardware by driving the menu over serial and
  watching the step counters move.

## Serial debug keys

On the USB serial console (115200): `w/a/s/d` = virtual joystick,
`c`/`z` = C/Z buttons, `p` = print position, motor state, engine state, and
current program step.

Panic output goes to UART0, which is invisible on the USB monitor — crashes
look like silent reboots. Symbolize a saved PC with:
`~/.platformio/packages/toolchain-xtensa-esp32s3/bin/xtensa-esp32s3-elf-addr2line -pfiaC -e .pio/build/esp32-s3-devkitc-1/firmware.elf <PC>`

## Web interface

The device runs a WiFi access point:

- **SSID** `TB3-Black`, **password** `tb3black109`
- UI: **http://10.31.31.1/** (mobile-friendly; live LCD mirror, virtual
  joystick, C/Z buttons, AUX slider, camera fire/focus, battery/position
  telemetry, Bluetooth pairing status, STA WiFi setup)

Optionally join your home WiFi from the UI's Network card (or
`POST /api/wifi`); the device then also gets a LAN address and advertises
itself as `tb3.local` (mDNS). The AP stays up either way.

All existing firmware menus work remotely: web (and gamepad) input feeds the
same virtual joystick the firmware already reads, and the web UI mirrors the
16x2 LCD, so anything you can do standing at the device you can do from the
browser.

## Web API

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/status` | — | position, moving bits, program state, shots, battery, WiFi/BT info, heap, uptime |
| GET | `/api/lcd` | — | `{line1,line2}` mirror of the panel |
| GET | `/api/info` | — | firmware version/build |
| POST | `/api/joy` | `{"x":-100..100,"y":-100..100,"aux":-100..100}` | virtual joystick; auto-centers 750 ms after the last update (deadman) — keep sending while jogging |
| POST | `/api/button` | `{"button":"c"\|"z","ms":30..2000}` | timed virtual button press (C = select, Z = back) |
| POST | `/api/camera` | `{"action":"shoot"\|"focus","ms":30..30000}` | drives the shutter/focus opto outputs directly |
| POST | `/api/stop` | — | centers inputs and requests a motor hard stop |
| GET/POST | `/api/bt` | `{"forget":true}` | gamepad status; `forget` clears BLE bonds |
| GET/POST | `/api/wifi` | `{"ssid":"…","pass":"…"}` | store/read STA credentials (empty ssid clears) |

WebSocket `/ws`: pushes a telemetry tick (LCD, position, battery, BT, program
state) at 5 Hz and accepts the same JSON as `/api/joy` / `/api/button` for
low-latency control. Example:

```bash
curl http://10.31.31.1/api/status
curl -X POST http://10.31.31.1/api/joy -H 'Content-Type: application/json' \
     -d '{"x":40,"y":0,"aux":0}'
curl -X POST http://10.31.31.1/api/camera -H 'Content-Type: application/json' \
     -d '{"action":"shoot","ms":150}'
```

## Bluetooth gamepad

Pairing runs entirely on the device (no web UI needed): the firmware scans
for supported controllers whenever none is connected — just put the pad in
pairing mode near the device. Bonds persist across power cycles; use "Forget
pads" in the UI (or `POST /api/bt {"forget":true}`) to clear them.

**The ESP32-S3 is BLE-only.** Supported: Xbox One (models 1697/1708) and
Xbox Series X|S controllers over BLE (update the pad firmware via the Xbox
Accessories app if it won't pair). PS4/PS5/Switch pads are Bluetooth Classic
and cannot connect. (Library: vendored `BLE-Gamepad-Client` in `lib/`, which
also supports the Steam Controller if wired up later.)

Mapping: left stick = pan/tilt, right stick X or d-pad = AUX/menus,
**A** = C button (select), **B** = Z button (back).

## Wiring (ESP32-S3 pin map)

Steps 5/6/7 · Dirs 10/38/12 · Enables 13/14 · MS1-3 15/16/17 ·
Camera 18 · Focus 21 · LCD TX GPIO4 (Serial1 @9600) · External trigger GPIO3 ·
Battery divider A0/GPIO1. GPIO 26–32 are flash, 33–37 PSRAM — do not use.
Tilt DIR is GPIO38 (J3 pin 10): the GPIO11 output pad died 2026-07; GPIO11 is
now unused — do not wire anything to it.
