# TB3 Black — ESP32-S3 Pin Map (Arduino ↔ GPIO)

Reference for the eMotimo TB3 Black port from the original ATmega board to the
ESP32-S3-DevKitC-1 (N16R8, octal PSRAM). Derived from the two pin tables in
`src/TB3_Black_109_Release1.ino` (the `#if defined(ESP32)` block = GPIOs this
port uses; the `#else` block = the original Arduino pins), the LCD driver
(`NHDLCD9.cpp`, Serial1 TX-only on GPIO4), and the battery-sense note.

> **I²C / GY-91 IMU:** the sensor's I²C bus goes on **GPIO8 = SDA, GPIO9 = SCL**
> — the S3's default `Wire` pins (the "Nunchuck" net; the nunchuck is virtual,
> so these are free). The IMU driver (`tb3_imu`, via `GET /api/imu`) owns the
> bus with `Wire.begin(8, 9)` in `tb3_imu_begin()`.
> Do **not** use GPIO16/17 for I²C — those are MS2/MS3 (stepper microstep) and
> are driven HIGH by the firmware.

## J1 header (left side), in physical order

| J1 pin | ESP32-S3 pin | Arduino pin | TB3 Black signal |
|---|---|---|---|
| 1, 2 | 3V3 | 3.3V | logic supply (see warnings) |
| 3 | RST (EN) | RESET | reset |
| 4 | GPIO4 | **D4** | Serial LCD data (Serial1 TX @ 9600, TX-only) |
| 5 | GPIO5 | **D5** | Motor 0 (pan) STEP |
| 6 | GPIO6 | **D6** | Motor 1 (tilt) STEP |
| 7 | GPIO7 | **D7** | Motor 2 (aux) STEP |
| 8 | GPIO15 | **A1** | MS1 (microstep select) |
| 9 | GPIO16 | **A2** | MS2 |
| 10 | GPIO17 | **A2** (same net) | MS3 — see note ① |
| 11 | GPIO18 | **D12** | CAMERA_PIN (shutter, tip of 2.5 mm jack) |
| 12 | GPIO8 | **A4** (SDA) | Nunchuck I²C data — see note ② |
| 13 | GPIO3 | **D3** | IO_3 — I/O port, tip of 2.5 mm jack (ext trigger) |
| 14 | GPIO46 | — | **do not use** (strapping pin) |
| 15 | GPIO9 | **A5** (SCL) | Nunchuck I²C clock — see note ② |
| 16 | GPIO10 | **D8** | Motor 0 DIR |
| 17 | GPIO11 | **D9** | Motor 1 DIR — **pad damaged 2026-07; DIR-tilt moved to GPIO38** |
| 18 | GPIO12 | **D10** | Motor 2 DIR |
| 19 | GPIO13 | **A3** | MOTOR_EN (LOW = enabled) |
| 20 | GPIO14 | **D11** | MOTOR_EN2 (LOW = enabled) |
| 21 | 5V | 5V / VIN | power in |
| 22 | G | GND | ground |

## J3 header (right side), in physical order

| J3 pin | ESP32-S3 pin | Arduino pin | TB3 Black signal |
|---|---|---|---|
| 1 | G | GND | ground |
| 2 | TX (GPIO43) | **D1** (TX) | UART0 — panic/boot log lands here, not on USB |
| 3 | RX (GPIO44) | **D0** (RX) | UART0 RX |
| 4 | GPIO1 | **A0** | Battery voltage divider (ADC1_CH0, 12-bit) — see note ③ |
| 5 | GPIO2 | **D2** | IO_2 — I/O port, middle of 2.5 mm jack |
| 6–10 | GPIO42, 41, 40, 39, 38 | — | free / spare (GPIO38 now = DIR-tilt) |
| 11–13 | GPIO37, 36, 35 | — | **do not use** (octal PSRAM on the N16R8 module) |
| 14 | GPIO0 | — | **do not use** (BOOT strapping) |
| 15 | GPIO45 | — | **do not use** (strapping) |
| 16 | GPIO48 | — | onboard RGB LED (usable if you accept the flicker) |
| 17 | GPIO47 | — | free |
| 18 | GPIO21 | **D13** | FOCUS_PIN (middle of 2.5 mm camera jack) |
| 19 | GPIO20 | — | **do not use** (USB D+, native USB console/flash) |
| 20 | GPIO19 | — | **do not use** (USB D−) |
| 21, 22 | G | GND | ground |

## Same map, Arduino-side view (D2–D13, A0–A5)

| Arduino | ESP32-S3 GPIO | Signal |
|---|---|---|
| D2 | GPIO2 | I/O port middle (ext trigger) |
| D3 | GPIO3 | I/O port tip |
| D4 | GPIO4 | Serial LCD |
| D5 / D6 / D7 | GPIO5 / 6 / 7 | STEP pan / tilt / aux |
| D8 / D9 / D10 | GPIO10 / 11 / 12 | DIR pan / tilt / aux (tilt now on GPIO38, see ①) |
| D11 | GPIO14 | MOTOR_EN2 |
| D12 | GPIO18 | Camera shutter |
| D13 | GPIO21 | Focus |
| A0 | GPIO1 | Battery sense |
| A1 | GPIO15 | MS1 |
| A2 | GPIO16 (+17) | MS2 / MS3 ① |
| A3 | GPIO13 | MOTOR_EN |
| A4 / A5 | **GPIO8 / GPIO9** | **Nunchuck SDA / SCL ② — this is the I²C bus for the GY-91** |

Most wiring runs down J1 in physical order: the port deliberately kept D2–D7
identical to the GPIO number (GPIO2–GPIO7) and shifted the rest to dodge the
S3's reserved pins.

## Notes

**① MS2/MS3:** on the original AVR board both driver inputs were driven by the
single pin A2. The ESP32 port splits them: MS2→GPIO16, MS3→GPIO17. Firmware
drives both HIGH for 1/16 microstep (`STEPS_PER_DEG 444.444` assumes this) and
re-asserts them before homing. If the driver pads are permanently tied, only
GPIO16 need be wired and GPIO17 left floating — two outputs must not be shorted.
**GPIO17's DIR-tilt neighbor (GPIO11) has a damaged pad**, which is why tilt DIR
was moved to GPIO38.

**② Nunchuck / I²C:** the physical nunchuck isn't read in this port — the
joystick is virtual (web UI / BLE gamepad feed the same variables). GPIO8/9 are
the S3's default `Wire` pins, so they are the correct place for the GY-91 IMU's
I²C bus. There is no other `Wire.begin()` in the firmware; this is a fresh bus.

**③ Battery-sense caveat:** firmware reads the battery on the Arduino `A0`
constant, which on this variant = **GPIO1** (`_TB3_LCD_Buttons.ino` battery
read). If the physical divider is on a different pin than GPIO1, `battery_v`
telemetry is wrong — verify against a meter before trusting it.

## Hardware cautions

- **Logic level:** the ESP32-S3 is 3.3 V and its pins are **not 5 V tolerant**.
  STEP/DIR/EN/MS inputs on the stepper drivers accept 3.3 V fine, but anything
  that *outputs* 5 V toward the MCU (nunchuck-port pull-ups, external trigger on
  D2/D3, a battery divider sized for a 5 V ADC reference) needs a level shifter
  or re-scaled divider first. The **GY-91 is a 3.3 V board** — power it from 3V3,
  not 5V.
- **GPIO3 (D3, trigger tip) is a strapping pin** — fine as an I/O line, but make
  sure the external trigger circuit can't hold it during reset or you can change
  the JTAG/boot source.
