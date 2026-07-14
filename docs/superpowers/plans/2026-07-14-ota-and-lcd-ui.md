# OTA + LCD Page Rotation + Web Program Picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add over-the-air firmware updates (browser + `espota`, with bootloader rollback), a live-rotating 16x2 LCD (idle: program name + cycling IP; running: classic page alternating with a pan/tilt/mode page), and a web-UI program picker to the TB3 Black ESP32-S3 firmware.

**Architecture:** All periodic LCD work runs in loopTask via a single `tb3_lcd_tick()` hung off the existing `NunChuckQuerywithEC()` input cycle — no new task touches the non-thread-safe LCD. Page *formatting* is isolated in a pure, Arduino-free module (`tb3_lcd_pages`) that is host-unit-tested; hardware access stays behind glue accessors in `TB3_WebGlue.ino`. OTA shares one `Update.h` path behind a safety gate (refuse while a program is engaged or a motor is moving; stop the 40 kHz step ISR during the write) and defers the Arduino core's rollback confirmation until the new image proves healthy.

**Tech Stack:** C++ / Arduino-ESP32 (pioarduino), PlatformIO, ESPAsyncWebServer, ArduinoJson, bundled `Update` + `ArduinoOTA` libraries, PlatformIO Unity for host tests.

## Global Constraints

- Target board env is `esp32-s3-devkitc-1`; all firmware code is guarded `#if defined(ESP32)`. Copy this guard on every new `.cpp`.
- The LCD (`NHDLCD9 lcd(4,2,16)` — Serial1/GPIO4, 9600 baud) and its shadow buffer are **not thread-safe**. Every `lcd.*` call must run in loopTask context only. No background task may write the LCD.
- A full 32-char LCD repaint costs ~33 ms at 9600 baud. Only write on a page flip or a changed value.
- `STEPS_PER_DEG` = `444.444` (`TB3_Black_109_Release1.ino:307`). Degree conversion uses this exact constant.
- Partition table is unchanged (`default_16MB.csv`: `otadata` + `ota_0`@0x10000 + `ota_1`@0x650000). Do **not** edit partitions.
- OTA is refused if `Program_Engaged` is true OR `motorMoving != 0`. There is **no force override**.
- Program menu: `MENU_OPTIONS` = 8, `progtype` 0..7 = New 2-Pt(0), Rev 2-Pt(1), New 3-Pt(2), Rev 3-Pt(3), Panorama(4), Portrait Pano(5), DF Slave(6), Setup Menu(7). `Choose_Program()` runs at `progstep` ∈ {0,100,200,210,300}.
- Running screen is active at `progstep` ∈ {50,51,52,250}.
- Idle line 2 shows bare, centered IP addresses — **no `AP`/`STA` prefix**.
- New `.cpp` files use direct GPIO/register style already established; match existing brace and naming style in `tb3_web.cpp`. Do not reformat legacy `.ino` files.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/tb3_lcd_pages.h` / `.cpp` | **Pure, Arduino-free.** `Tb3UiState` struct + formatters that render one 16-char LCD line/page. Host-unit-tested. |
| `src/tb3_lcd_ui.h` / `.cpp` | The tick: zone detection from `progstep`, page timer, dirty tracking, calls glue accessors to read state and write the LCD. Owns run-page index. |
| `src/tb3_ota.h` / `.cpp` | Shared `Update` sequence, safety gate wiring, web `/api/ota` upload handler, `ArduinoOTA` task, rollback confirmation. |
| `src/TB3_WebGlue.ino` | (modify) Glue accessors bridging `.cpp` modules to `.ino` globals: UI state read, LCD line write, program-select, OTA gate/prepare, rollback health. |
| `src/tb3_web.cpp` | (modify) Register `/api/program` and `/api/ota` routes; start OTA. |
| `src/tb3_web.h` | (modify) Declare the new glue functions. |
| `src/tb3_ui.h` | (modify) Add the program-picker card and the OTA card to `TB3_INDEX_HTML`. |
| `src/TB3_Nunchuck.ino` | (modify) Call `tb3_lcd_tick()` after `tb3_web_poll()`. |
| `src/_TB3_LCD_Buttons.ino` | (modify) Guard `display_status()` so it repaints only when the status page is showing. |
| `src/TB3_Black_109_Release1.ino` | (modify) `#include "tb3_lcd_ui.h"`; add rollback health check in `loop()`. |
| `platformio.ini` | (modify) Add `[env:native]` for host tests; add `espota` upload settings (commented default). |
| `test/test_lcd_pages/test_lcd_pages.cpp` | Host unit tests for `tb3_lcd_pages`. |
| `README.md` | (modify) Document OTA, LCD behavior, program picker. |

---

## Task 1: Pure LCD page formatters + host test env

**Files:**
- Create: `src/tb3_lcd_pages.h`, `src/tb3_lcd_pages.cpp`
- Create: `test/test_lcd_pages/test_lcd_pages.cpp`
- Modify: `platformio.ini` (add `[env:native]`)

**Interfaces:**
- Produces:
  - `struct Tb3UiState { bool sta_connected; char ap_ip[16]; char sta_ip[16]; uint16_t progtype; uint16_t progstep; uint16_t phase2pt; uint16_t phase3pt; uint16_t interval_mode; float pan_deg; float tilt_deg; };`
  - `void tb3_fmt_idle_hint(char out[17]);`
  - `void tb3_fmt_ip_centered(char out[17], const char *ip);`
  - `void tb3_fmt_run_page2_l1(char out[17], const Tb3UiState &s);`
  - `void tb3_fmt_run_page2_l2(char out[17], const Tb3UiState &s);`
  - Every formatter writes **exactly 16 chars + NUL** (`strlen(out) == 16`).

- [ ] **Step 1: Add the native test environment**

Append to `platformio.ini`:

```ini

[env:native]
platform = native
build_flags = -std=gnu++17
test_framework = unity
```

- [ ] **Step 2: Write the failing test**

Create `test/test_lcd_pages/test_lcd_pages.cpp`:

```cpp
#include <unity.h>
#include <string.h>
#include "../../src/tb3_lcd_pages.h"

static Tb3UiState mk() {
  Tb3UiState s{};
  s.sta_connected = false;
  strcpy(s.ap_ip, "10.31.31.1");
  s.sta_ip[0] = 0;
  s.progtype = 0; s.progstep = 50;
  s.phase2pt = 3; s.phase3pt = 1;
  s.interval_mode = 10; // SMS
  s.pan_deg = 42.3f; s.tilt_deg = -11.8f;
  return s;
}

void test_idle_hint(void) {
  char b[17];
  tb3_fmt_idle_hint(b);
  TEST_ASSERT_EQUAL_STRING("UpDown  C-Select", b);
  TEST_ASSERT_EQUAL_UINT(16, strlen(b));
}

void test_ip_centered_short(void) {
  char b[17];
  tb3_fmt_ip_centered(b, "10.31.31.1");
  TEST_ASSERT_EQUAL_STRING("   10.31.31.1   ", b);
  TEST_ASSERT_EQUAL_UINT(16, strlen(b));
}

void test_ip_centered_long(void) {
  char b[17];
  tb3_fmt_ip_centered(b, "192.168.100.100"); // 15 chars
  TEST_ASSERT_EQUAL_STRING("192.168.100.100 ", b);
  TEST_ASSERT_EQUAL_UINT(16, strlen(b));
}

void test_run_l1_2pt_sms_linear(void) {
  char b[17];
  Tb3UiState s = mk(); // 2Pt, SMS, phase2pt=3 -> Linea
  tb3_fmt_run_page2_l1(b, s);
  TEST_ASSERT_EQUAL_STRING("2Pt SMS    Linea", b);
  TEST_ASSERT_EQUAL_UINT(16, strlen(b));
}

void test_run_l1_video_and_3pt_and_pano(void) {
  char b[17];
  Tb3UiState s = mk();
  s.interval_mode = 2; // video
  tb3_fmt_run_page2_l1(b, s);
  TEST_ASSERT_EQUAL_STRING("2Pt Vid    Linea", b);

  s = mk(); s.progtype = 2; s.phase3pt = 102; // 3Pt, Leg 1
  tb3_fmt_run_page2_l1(b, s);
  TEST_ASSERT_EQUAL_STRING("3Pt SMS    Leg 1", b);

  s = mk(); s.progtype = 4; // Pano
  tb3_fmt_run_page2_l1(b, s);
  TEST_ASSERT_EQUAL_STRING("Pano SMS    Pano", b);
}

void test_run_l2_degrees(void) {
  char b[17];
  Tb3UiState s = mk(); // 42.3 / -11.8
  tb3_fmt_run_page2_l2(b, s);
  TEST_ASSERT_EQUAL_STRING("P+42.3  T-11.8  ", b);
  TEST_ASSERT_EQUAL_UINT(16, strlen(b));

  s.pan_deg = 0.0f; s.tilt_deg = 0.0f;
  tb3_fmt_run_page2_l2(b, s);
  TEST_ASSERT_EQUAL_STRING("P+0.0   T+0.0   ", b);
}

int main(int, char **) {
  UNITY_BEGIN();
  RUN_TEST(test_idle_hint);
  RUN_TEST(test_ip_centered_short);
  RUN_TEST(test_ip_centered_long);
  RUN_TEST(test_run_l1_2pt_sms_linear);
  RUN_TEST(test_run_l1_video_and_3pt_and_pano);
  RUN_TEST(test_run_l2_degrees);
  return UNITY_END();
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pio test -e native -f test_lcd_pages`
Expected: FAIL — `fatal error: '../../src/tb3_lcd_pages.h' file not found` (header not created yet).

- [ ] **Step 4: Write the header**

Create `src/tb3_lcd_pages.h`:

```cpp
#ifndef TB3_LCD_PAGES_H
#define TB3_LCD_PAGES_H

#include <stdint.h>

// Pure, Arduino-free LCD page formatting. Every formatter writes exactly
// 16 printable chars plus a NUL into out[17]. Host-unit-tested.

struct Tb3UiState {
  bool     sta_connected;
  char     ap_ip[16];        // e.g. "10.31.31.1"
  char     sta_ip[16];       // e.g. "192.168.1.42" or "" when not joined
  uint16_t progtype;         // 0..7 (see plan Global Constraints)
  uint16_t progstep;
  uint16_t phase2pt;         // program_progress_2PT
  uint16_t phase3pt;         // program_progress_3PT
  uint16_t interval_mode;    // intval: 2 = video, else SMS
  float    pan_deg;          // current_steps.x / STEPS_PER_DEG
  float    tilt_deg;         // current_steps.y / STEPS_PER_DEG
};

void tb3_fmt_idle_hint(char out[17]);
void tb3_fmt_ip_centered(char out[17], const char *ip);
void tb3_fmt_run_page2_l1(char out[17], const Tb3UiState &s);
void tb3_fmt_run_page2_l2(char out[17], const Tb3UiState &s);

#endif // TB3_LCD_PAGES_H
```

- [ ] **Step 5: Write the implementation**

Create `src/tb3_lcd_pages.cpp`:

```cpp
#include "tb3_lcd_pages.h"
#include <stdio.h>
#include <string.h>

// Space-pad (or truncate) src to exactly 16 chars + NUL in out[17].
static void pad16(char out[17], const char *src) {
  size_t n = strlen(src);
  if (n > 16) n = 16;
  memcpy(out, src, n);
  for (size_t i = n; i < 16; i++) out[i] = ' ';
  out[16] = 0;
}

void tb3_fmt_idle_hint(char out[17]) {
  pad16(out, "UpDown  C-Select");
}

void tb3_fmt_ip_centered(char out[17], const char *ip) {
  char tmp[17];
  size_t n = strlen(ip);
  if (n >= 16) { pad16(out, ip); return; }   // >=16 truncates via pad16
  size_t left = (16 - n) / 2;
  size_t k = 0;
  for (size_t i = 0; i < left; i++) tmp[k++] = ' ';
  memcpy(tmp + k, ip, n); k += n;
  tmp[k] = 0;
  pad16(out, tmp);
}

static const char *type_label(uint16_t t) {
  switch (t) {
    case 0: return "2Pt";
    case 1: return "Rev2";
    case 2: return "3Pt";
    case 3: return "Rev3";
    case 4: return "Pano";
    case 5: return "Port";
    default: return "?";
  }
}

static const char *phase_label(const Tb3UiState &s) {
  if (s.progtype == 4 || s.progtype == 5) return "Pano";
  if (s.progtype == 2 || s.progtype == 3) {
    switch (s.phase3pt) {
      case 101: return "LeadIn";
      case 102: return "Leg 1";
      case 103: return "Leg 2";
      case 105: return "LeadOT";
      case 109: return "Finish";
      default:  return "";
    }
  }
  switch (s.phase2pt) {            // 2Pt reg/rev
    case 1: return "LeadIn";
    case 2: return "RampUp";
    case 3: return "Linea";
    case 4: return "RampDn";
    case 5: return "LeadOT";
    case 9: return "Finish";
    default: return "";
  }
}

void tb3_fmt_run_page2_l1(char out[17], const Tb3UiState &s) {
  const char *intv = (s.interval_mode == 2) ? "Vid" : "SMS";
  char tmp[24];
  // type left in a 4-wide field, interval in a 3-wide field, phase
  // right-justified in a 9-wide field: 4 + 3 + 9 = 16.
  snprintf(tmp, sizeof(tmp), "%-4.4s%-3.3s%9.9s",
           type_label(s.progtype), intv, phase_label(s));
  pad16(out, tmp);
}

void tb3_fmt_run_page2_l2(char out[17], const Tb3UiState &s) {
  char lh[16], rh[16], tmp[24];
  // "P" + signed 1-decimal degrees, each half left-justified in 8 cols.
  snprintf(lh, sizeof(lh), "P%+.1f", (double)s.pan_deg);
  snprintf(rh, sizeof(rh), "T%+.1f", (double)s.tilt_deg);
  snprintf(tmp, sizeof(tmp), "%-8.8s%-8.8s", lh, rh);
  pad16(out, tmp);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pio test -e native -f test_lcd_pages`
Expected: PASS — `6 Tests 0 Failures 0 Ignored`.

- [ ] **Step 7: Commit**

```bash
git add src/tb3_lcd_pages.h src/tb3_lcd_pages.cpp test/test_lcd_pages/test_lcd_pages.cpp platformio.ini
git commit -m "feat: pure LCD page formatters with host unit tests"
```

---

## Task 2: LCD tick — idle + run rotation on hardware

**Files:**
- Create: `src/tb3_lcd_ui.h`, `src/tb3_lcd_ui.cpp`
- Modify: `src/TB3_WebGlue.ino` (glue accessors)
- Modify: `src/tb3_web.h` (declare glue accessors)
- Modify: `src/TB3_Nunchuck.ino:123` (call the tick)
- Modify: `src/TB3_Black_109_Release1.ino` (include header)
- Modify: `src/_TB3_LCD_Buttons.ino:1737` (guard `display_status()`)

**Interfaces:**
- Consumes: `Tb3UiState`, `tb3_fmt_*` (Task 1).
- Produces:
  - `void tb3_lcd_tick();` — call each input cycle from loopTask.
  - `bool tb3_lcd_showing_status_page();` — true when the run rotation is on page 1 (the classic status page) or not in the run zone; `display_status()` uses it to decide whether to paint.
  - Glue (in `TB3_WebGlue.ino`, declared in `tb3_web.h`):
    - `Tb3UiState tb3_ui_get_state();`
    - `void tb3_ui_write_line(uint8_t row1based, const char *text16);`

- [ ] **Step 1: Add glue accessors in `TB3_WebGlue.ino`**

Insert before the final `#endif // ESP32` in `src/TB3_WebGlue.ino`:

```cpp
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
```

- [ ] **Step 2: Declare the glue in `tb3_web.h`**

In `src/tb3_web.h`, after the `tb3_request_stop();` line (inside the `.ino`-side block), add:

```cpp
struct Tb3UiState;                 // defined in tb3_lcd_pages.h
Tb3UiState tb3_ui_get_state();
void tb3_ui_write_line(uint8_t row1based, const char *text16);
```

- [ ] **Step 3: Write the tick header**

Create `src/tb3_lcd_ui.h`:

```cpp
#ifndef TB3_LCD_UI_H
#define TB3_LCD_UI_H

#include <stdint.h>

// Called every input cycle from NunChuckQuerywithEC() (loopTask context).
// Rotates the idle line-2 pages and the running dual pages. Inert on every
// other screen.
void tb3_lcd_tick();

// True when the run rotation is currently on the classic status page (page 0)
// or the device is not in the run zone at all. display_status() paints only
// when this is true so the tick and display_status() never fight for the LCD.
bool tb3_lcd_showing_status_page();

#endif // TB3_LCD_UI_H
```

- [ ] **Step 4: Write the tick implementation**

Create `src/tb3_lcd_ui.cpp`:

```cpp
#if defined(ESP32)

#include <Arduino.h>
#include "tb3_lcd_ui.h"
#include "tb3_lcd_pages.h"
#include "tb3_web.h"   // tb3_ui_get_state / tb3_ui_write_line

static const uint32_t PAGE_MS = 3000;

enum Zone { ZONE_OTHER, ZONE_IDLE, ZONE_RUN };

static Zone zoneFor(uint16_t progstep) {
  switch (progstep) {
    case 0: case 100: case 200: case 210: case 300: return ZONE_IDLE;
    case 50: case 51: case 52: case 250:            return ZONE_RUN;
    default:                                        return ZONE_OTHER;
  }
}

static Zone     s_zone = ZONE_OTHER;
static uint8_t  s_page = 0;
static uint32_t s_flip = 0;
static char     s_last1[17] = "";
static char     s_last2[17] = "";

// Idle pages: 0 = hint, 1 = AP ip, 2 = STA ip (only when joined).
static uint8_t idlePageCount(const Tb3UiState &s) { return s.sta_connected ? 3 : 2; }

bool tb3_lcd_showing_status_page() {
  return !(s_zone == ZONE_RUN && s_page == 1);
}

static void writeLine(uint8_t row, const char *text, char *cache) {
  if (strcmp(text, cache) == 0) return;   // unchanged -> skip the ~16ms write
  tb3_ui_write_line(row, text);
  strcpy(cache, text);
}

void tb3_lcd_tick() {
  Tb3UiState s = tb3_ui_get_state();
  Zone z = zoneFor(s.progstep);
  uint32_t now = millis();

  if (z != s_zone) {                       // zone change: reset rotation
    s_zone = z; s_page = 0; s_flip = now;
    s_last1[0] = s_last2[0] = 0;           // force repaint
  }

  if (z == ZONE_OTHER) return;             // do not touch the LCD

  if (z == ZONE_IDLE) {
    uint8_t n = idlePageCount(s);
    if (now - s_flip >= PAGE_MS) { s_page = (s_page + 1) % n; s_flip = now; }
    if (s_page >= n) s_page = 0;
    char l2[17];
    if (s_page == 0)      tb3_fmt_idle_hint(l2);
    else if (s_page == 1) tb3_fmt_ip_centered(l2, s.ap_ip);
    else                  tb3_fmt_ip_centered(l2, s.sta_ip);
    writeLine(2, l2, s_last2);             // line 1 (program name) left to the menu
    return;
  }

  // ZONE_RUN: alternate page 0 (classic status) and page 1 (pan/tilt/mode).
  if (now - s_flip >= PAGE_MS) {
    s_page ^= 1; s_flip = now;
    s_last1[0] = s_last2[0] = 0;           // force full repaint on flip
  }
  if (s_page == 0) {
    // Page 0 is painted by display_status() (guarded by
    // tb3_lcd_showing_status_page()); the tick does not draw it. On the flip
    // INTO page 0 we clear the cache so display_status repaints fully.
    return;
  }
  char l1[17], l2[17];
  tb3_fmt_run_page2_l1(l1, s);
  tb3_fmt_run_page2_l2(l2, s);
  writeLine(1, l1, s_last1);
  writeLine(2, l2, s_last2);
}

#endif // ESP32
```

- [ ] **Step 5: Hook the tick into the input cycle**

In `src/TB3_Nunchuck.ino`, at line 123, immediately after `tb3_web_poll();`:

```cpp
    tb3_web_poll();
    tb3_lcd_tick();
```

And add the include near the top of `src/TB3_Black_109_Release1.ino` (with the other `#if defined(ESP32)` includes for the web module):

```cpp
#if defined(ESP32)
#include "tb3_lcd_ui.h"
#endif
```

- [ ] **Step 6: Guard `display_status()`**

In `src/_TB3_LCD_Buttons.ino`, at the top of `display_status()` (line 1732, right after the opening brace, before the `if (first_time==1)` block), add:

```cpp
void display_status()  {
#if defined(ESP32)
  // The LCD tick owns page 2 of the run rotation; don't repaint the classic
  // status page while page 2 is showing, or the two fight over the panel.
  if (!tb3_lcd_showing_status_page()) return;
#endif
```

(Add `#include "tb3_lcd_ui.h"` is already provided via the main `.ino` include from Step 5, since all `.ino` files compile as one translation unit.)

- [ ] **Step 7: Build for hardware**

Run: `pio run -e esp32-s3-devkitc-1`
Expected: `SUCCESS`. If it fails on a missing declaration, confirm `tb3_web.h` Step 2 was applied and `Tb3UiState` is forward-declared there.

- [ ] **Step 8: Flash and verify on hardware**

Run: `pio run -e esp32-s3-devkitc-1 -t upload`
Then observe the panel:
- Top menu: line 1 still shows the program name and follows up/down; line 2 cycles hint → `10.31.31.1` (~3 s each). Join a WiFi network from the web UI and confirm a third page with the LAN IP appears; leave it and confirm it drops back to two pages.
- Start an SMS shoot: the screen alternates ~3 s between the classic `shots/phase` + `time/battery` page and `<type> <SMS/Vid> <phase>` + `P±.. T±..` degrees. Classic page still updates per shot.
- Visit a setup/jog screen: unchanged, no rotation.

- [ ] **Step 9: Commit**

```bash
git add src/tb3_lcd_ui.h src/tb3_lcd_ui.cpp src/TB3_WebGlue.ino src/tb3_web.h \
        src/TB3_Nunchuck.ino src/TB3_Black_109_Release1.ino src/_TB3_LCD_Buttons.ino
git commit -m "feat: rotating LCD — idle IP pages and run pan/tilt/mode page"
```

---

## Task 3: Web program picker

**Files:**
- Modify: `src/TB3_WebGlue.ino` (program glue)
- Modify: `src/tb3_web.h` (declare glue)
- Modify: `src/tb3_web.cpp` (routes)
- Modify: `src/tb3_ui.h` (picker card)

**Interfaces:**
- Consumes: `s_btn_c_until` (existing static in `tb3_web.cpp`).
- Produces (glue in `TB3_WebGlue.ino`, declared in `tb3_web.h`):
  - `bool tb3_program_selectable();` — true when at a `Choose_Program()` step.
  - `int  tb3_program_current();` — current `progtype`.
  - `void tb3_program_set_type(int t);` — set `progtype` (0..7) and `first_time=1`.

- [ ] **Step 1: Add program glue in `TB3_WebGlue.ino`**

Insert before the final `#endif // ESP32` in `src/TB3_WebGlue.ino`:

```cpp
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
```

- [ ] **Step 2: Declare the glue in `tb3_web.h`**

After the Task 2 declarations in `src/tb3_web.h`:

```cpp
bool tb3_program_selectable();
int  tb3_program_current();
void tb3_program_set_type(int t);
```

- [ ] **Step 3: Add the routes in `tb3_web.cpp`**

In `setupRoutes()` in `src/tb3_web.cpp`, after the `/api/wifi` POST handler, add a program-name table and the two routes:

```cpp
  static const char *PROGRAM_NAMES[8] = {
    "New 2-Pt Move", "Rev 2-Pt Move", "New 3-Pt Move", "Rev 3-Pt Move",
    "Panorama", "Portrait Pano", "DF Slave", "Setup Menu"
  };

  s_server.on("/api/program", HTTP_GET, [](AsyncWebServerRequest *req) {
    JsonDocument d;
    d["current"] = tb3_program_current();
    d["selectable"] = tb3_program_selectable();
    JsonArray names = d["names"].to<JsonArray>();
    for (auto n : PROGRAM_NAMES) names.add(n);
    String out; serializeJson(d, out);
    sendJson(req, 200, out);
  });

  s_server.addHandler(new AsyncCallbackJsonWebHandler("/api/program",
    [](AsyncWebServerRequest *req, JsonVariant &json) {
      JsonVariantConst d = json.as<JsonVariantConst>();
      int type = d["type"] | -1;
      bool select = d["select"] | false;
      if (type < 0 || type > 7) {
        sendJson(req, 400, "{\"error\":\"type must be 0..7\"}");
        return;
      }
      if (!tb3_program_selectable()) {
        sendJson(req, 409, "{\"error\":\"not at the program menu\"}");
        return;
      }
      tb3_program_set_type(type);
      if (select) s_btn_c_until = millis() + 80;  // virtual C-press commits it
      sendJson(req, 200, "{\"ok\":true}");
    }));
```

- [ ] **Step 4: Build**

Run: `pio run -e esp32-s3-devkitc-1`
Expected: `SUCCESS`.

- [ ] **Step 5: Add the picker card to the web UI**

In `src/tb3_ui.h`, inside `TB3_INDEX_HTML`, add a card in the `.grid` (place it after the Network card). Insert this markup:

```html
<div class="card">
  <h2>Program</h2>
  <div id="progList" style="display:flex;flex-direction:column;gap:6px"></div>
  <div id="progHint" style="color:var(--dim);font-size:12px;margin-top:8px"></div>
</div>
```

And add this script (near the other `fetch`/render JS in the page, before `</script>`):

```html
<script>
async function loadPrograms(){
  const r = await fetch('/api/program'); const p = await r.json();
  const box = document.getElementById('progList');
  box.innerHTML = '';
  p.names.forEach((name,i)=>{
    const b = document.createElement('button');
    b.textContent = name;
    b.className = 'btn' + (i===p.current?' on':'');
    b.disabled = !p.selectable;
    b.onclick = async ()=>{
      await fetch('/api/program',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({type:i,select:true})});
      setTimeout(loadPrograms, 300);
    };
    box.appendChild(b);
  });
  document.getElementById('progHint').textContent =
    p.selectable ? 'Tap a program to select and enter it.'
                 : 'Return to the top menu on the device to change programs.';
}
loadPrograms();
setInterval(loadPrograms, 4000);
</script>
```

- [ ] **Step 6: Flash and verify**

Run: `pio run -e esp32-s3-devkitc-1 -t upload`
- At the top menu, open the web UI Program card: 8 buttons, current one highlighted. Tap another and confirm the device LCD switches to that program name and enters it (matching a physical up/down + C).
- Start a program, reload the card: buttons disabled and the hint reads "Return to the top menu…". `curl -X POST http://10.31.31.1/api/program -H 'Content-Type: application/json' -d '{"type":4,"select":true}'` returns `409` mid-program.
- `curl -X POST ... -d '{"type":9,"select":true}'` returns `400`.

- [ ] **Step 7: Commit**

```bash
git add src/TB3_WebGlue.ino src/tb3_web.h src/tb3_web.cpp src/tb3_ui.h
git commit -m "feat: web program picker (GET/POST /api/program + UI card)"
```

---

## Task 4: OTA core — safety gate + browser upload

**Files:**
- Create: `src/tb3_ota.h`, `src/tb3_ota.cpp`
- Modify: `src/TB3_WebGlue.ino` (gate + prepare glue)
- Modify: `src/tb3_web.h` (declare glue + `tb3_ota_*`)
- Modify: `src/tb3_web.cpp` (register upload route, start OTA)
- Modify: `src/tb3_ui.h` (OTA card)

**Interfaces:**
- Consumes: `Program_Engaged`, `motorMoving`, `stopISR1()`, `disable_PT()`, `disable_AUX()` (all `.ino`).
- Produces:
  - Glue (in `TB3_WebGlue.ino`, declared in `tb3_web.h`):
    - `bool tb3_ota_safe_to_flash();` — `!Program_Engaged && motorMoving == 0`.
    - `void tb3_ota_prepare();` — stop the step ISR and disable motors.
  - `tb3_ota.h`:
    - `void tb3_ota_setup_web(AsyncWebServer &server);` — registers `POST`/`GET` `/api/ota`.
    - `enum Tb3OtaState { OTA_IDLE, OTA_RUNNING, OTA_ERROR };`
    - `Tb3OtaState tb3_ota_state();`
    - `int  tb3_ota_progress();`  // 0..100
    - `const char *tb3_ota_error();`

- [ ] **Step 1: Add gate + prepare glue in `TB3_WebGlue.ino`**

Insert before the final `#endif // ESP32`:

```cpp
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
```

- [ ] **Step 2: Declare in `tb3_web.h`**

After the Task 3 declarations:

```cpp
bool tb3_ota_safe_to_flash();
void tb3_ota_prepare();
```

- [ ] **Step 3: Write the OTA header**

Create `src/tb3_ota.h`:

```cpp
#ifndef TB3_OTA_H
#define TB3_OTA_H

#if defined(ESP32)
#include <ESPAsyncWebServer.h>

enum Tb3OtaState { OTA_IDLE, OTA_RUNNING, OTA_ERROR };

void         tb3_ota_setup_web(AsyncWebServer &server);  // POST/GET /api/ota
Tb3OtaState  tb3_ota_state();
int          tb3_ota_progress();       // 0..100
const char  *tb3_ota_error();

#endif // ESP32
#endif // TB3_OTA_H
```

- [ ] **Step 4: Write the OTA implementation (web upload path)**

Create `src/tb3_ota.cpp`:

```cpp
#if defined(ESP32)

#include "tb3_ota.h"
#include "tb3_web.h"      // tb3_ota_safe_to_flash / tb3_ota_prepare
#include <Update.h>
#include <ArduinoJson.h>

static volatile Tb3OtaState s_state = OTA_IDLE;
static volatile int s_progress = 0;
static char s_error[48] = "";

Tb3OtaState tb3_ota_state()   { return s_state; }
int         tb3_ota_progress(){ return s_progress; }
const char *tb3_ota_error()   { return s_error; }

static void fail(const char *msg) {
  snprintf(s_error, sizeof(s_error), "%s", msg);
  s_state = OTA_ERROR;
  Update.abort();
}

// Multipart upload: streamed chunk-by-chunk, never fully buffered in RAM.
static void onUpload(AsyncWebServerRequest *req, String filename, size_t index,
                     uint8_t *data, size_t len, bool final) {
  if (index == 0) {
    s_error[0] = 0; s_progress = 0;
    if (!tb3_ota_safe_to_flash()) { fail("busy - stop the program first"); return; }
    s_state = OTA_RUNNING;
    tb3_ota_prepare();                       // stop ISR + disable motors
    if (!Update.begin(UPDATE_SIZE_UNKNOWN)) { fail("Update.begin failed"); return; }
  }
  if (s_state != OTA_RUNNING) return;        // aborted earlier in this upload
  if (Update.write(data, len) != len)  { fail("flash write failed"); return; }
  // size is UNKNOWN to Update; approximate from the multipart body length.
  size_t total = req->contentLength();
  if (total) s_progress = (int)(((index + len) * 100) / total);
  if (final) {
    if (!Update.end(true)) { fail("Update.end failed"); return; }
    s_progress = 100;
    s_state = OTA_IDLE;                       // success; response triggers restart
  }
}

void tb3_ota_setup_web(AsyncWebServer &server) {
  server.on("/api/ota", HTTP_GET, [](AsyncWebServerRequest *req) {
    JsonDocument d;
    const char *st = (s_state == OTA_RUNNING) ? "running"
                   : (s_state == OTA_ERROR)   ? "error" : "idle";
    d["state"] = st;
    d["progress"] = s_progress;
    d["error"] = s_error;
    d["safe"] = tb3_ota_safe_to_flash();
    String out; serializeJson(d, out);
    AsyncWebServerResponse *r = req->beginResponse(200, "application/json", out);
    r->addHeader("Cache-Control", "no-store");
    req->send(r);
  });

  server.on("/api/ota", HTTP_POST,
    [](AsyncWebServerRequest *req) {           // completion handler
      bool ok = !Update.hasError() && s_state != OTA_ERROR;
      req->send(ok ? 200 : 400, "application/json",
                ok ? "{\"ok\":true}" : String("{\"error\":\"") + s_error + "\"}");
      if (ok) { delay(200); ESP.restart(); }
    },
    onUpload);
}

#endif // ESP32
```

- [ ] **Step 5: Register OTA in `tb3_web.cpp`**

At the top of `src/tb3_web.cpp` with the other includes:

```cpp
#include "tb3_ota.h"
```

In `tb3_web_begin()`, right after `setupRoutes();`:

```cpp
  setupRoutes();
  tb3_ota_setup_web(s_server);
```

- [ ] **Step 6: Build**

Run: `pio run -e esp32-s3-devkitc-1`
Expected: `SUCCESS`.

- [ ] **Step 7: Add the OTA card to the web UI**

In `src/tb3_ui.h`, add a card after the Program card:

```html
<div class="card">
  <h2>Firmware Update</h2>
  <input type="file" id="otaFile" accept=".bin">
  <button class="btn" id="otaBtn" onclick="doOta()">Upload &amp; Flash</button>
  <div style="background:var(--panel2);border-radius:6px;height:10px;margin-top:10px;overflow:hidden">
    <div id="otaBar" style="height:100%;width:0;background:var(--accent);transition:width .2s"></div>
  </div>
  <div id="otaMsg" style="color:var(--dim);font-size:12px;margin-top:6px"></div>
</div>
```

And the script before `</script>`:

```html
<script>
async function doOta(){
  const f = document.getElementById('otaFile').files[0];
  const msg = document.getElementById('otaMsg');
  if(!f){ msg.textContent='Choose a firmware.bin first.'; return; }
  const st = await (await fetch('/api/ota')).json();
  if(!st.safe){ msg.textContent='Busy — stop the program first.'; return; }
  const fd = new FormData(); fd.append('firmware', f);
  const xhr = new XMLHttpRequest();
  xhr.open('POST','/api/ota');
  xhr.upload.onprogress = e => {
    if(e.lengthComputable){
      const pct = Math.round(e.loaded*100/e.total);
      document.getElementById('otaBar').style.width = pct+'%';
      msg.textContent = 'Uploading '+pct+'%';
    }
  };
  xhr.onload = ()=>{ msg.textContent = xhr.status===200
      ? 'Flashed — device rebooting…' : 'Failed: '+xhr.responseText; };
  xhr.onerror = ()=>{ msg.textContent='Upload connection lost.'; };
  msg.textContent='Uploading…'; xhr.send(fd);
}
</script>
```

- [ ] **Step 8: Flash and verify browser OTA + gate**

Run: `pio run -e esp32-s3-devkitc-1 -t upload` (last USB flash — after this, OTA works).
- Build a new `.bin` (`pio run -e esp32-s3-devkitc-1`), then in the web UI pick `.pio/build/esp32-s3-devkitc-1/firmware.bin`, click Upload & Flash, watch the bar reach 100%, "device rebooting…", and confirm it comes back up.
- Also: `curl -F 'firmware=@.pio/build/esp32-s3-devkitc-1/firmware.bin' http://10.31.31.1/api/ota` → `{"ok":true}` then reboot.
- Start a program, then attempt an upload: the UI shows "Busy — stop the program first" and `GET /api/ota` reports `"safe":false`. Hit STOP, retry, confirm it flashes.

- [ ] **Step 9: Commit**

```bash
git add src/tb3_ota.h src/tb3_ota.cpp src/TB3_WebGlue.ino src/tb3_web.h src/tb3_web.cpp src/tb3_ui.h
git commit -m "feat: OTA browser upload with busy-gate and step-ISR shutdown"
```

---

## Task 5: OTA over espota (ArduinoOTA)

**Files:**
- Modify: `src/tb3_ota.h` (declare task starter)
- Modify: `src/tb3_ota.cpp` (ArduinoOTA task)
- Modify: `src/tb3_web.cpp` (start the task)
- Modify: `platformio.ini` (espota upload settings, commented)

**Interfaces:**
- Consumes: `tb3_ota_safe_to_flash()`, `tb3_ota_prepare()` (Task 4).
- Produces: `void tb3_ota_begin_espota();` — starts the `ArduinoOTA` service on a core-0 task.

- [ ] **Step 1: Declare the starter in `tb3_ota.h`**

Add before `#endif // ESP32`:

```cpp
void tb3_ota_begin_espota();   // ArduinoOTA on port 3232, hostname "tb3"
```

- [ ] **Step 2: Add the ArduinoOTA task in `tb3_ota.cpp`**

Add these includes at the top of `src/tb3_ota.cpp`:

```cpp
#include <ArduinoOTA.h>
#include <WiFi.h>
```

Add before `#endif // ESP32`:

```cpp
static void espotaTask(void *) {
  ArduinoOTA.setHostname("tb3");
  ArduinoOTA.setPort(3232);
  ArduinoOTA.onStart([]() {
    if (!tb3_ota_safe_to_flash()) {
      snprintf(s_error, sizeof(s_error), "busy - stop the program first");
      s_state = OTA_ERROR;
      return;             // core aborts the session on a thrown/failed start
    }
    s_state = OTA_RUNNING; s_progress = 0;
    tb3_ota_prepare();
  });
  ArduinoOTA.onProgress([](unsigned int cur, unsigned int total) {
    if (total) s_progress = (int)((cur * 100) / total);
  });
  ArduinoOTA.onEnd([]() { s_progress = 100; s_state = OTA_IDLE; });
  ArduinoOTA.onError([](ota_error_t) {
    snprintf(s_error, sizeof(s_error), "espota error");
    s_state = OTA_ERROR;
  });
  ArduinoOTA.begin();
  for (;;) { ArduinoOTA.handle(); vTaskDelay(pdMS_TO_TICKS(20)); }
}

void tb3_ota_begin_espota() {
  xTaskCreatePinnedToCore(espotaTask, "tb3_espota", 8192, nullptr, 1, nullptr, 0);
}
```

- [ ] **Step 3: Start the task in `tb3_web.cpp`**

In `tb3_web_begin()`, right after `tb3_ota_setup_web(s_server);`:

```cpp
  tb3_ota_setup_web(s_server);
  tb3_ota_begin_espota();
```

- [ ] **Step 4: Add espota upload settings to `platformio.ini`**

In `platformio.ini`, under `[env:esp32-s3-devkitc-1]`, add (commented so USB stays the default; uncomment to flash over the AP/LAN):

```ini
; Over-the-air upload (espota). Uncomment and set the address to flash
; wirelessly instead of over USB:
;   pio run -e esp32-s3-devkitc-1 -t upload --upload-port tb3.local
; upload_protocol = espota
; upload_port = tb3.local
```

- [ ] **Step 5: Build**

Run: `pio run -e esp32-s3-devkitc-1`
Expected: `SUCCESS`.

- [ ] **Step 6: Flash and verify espota**

Run once over USB: `pio run -e esp32-s3-devkitc-1 -t upload`.
Then, on the same network as the device's STA (or joined to its AP):
`pio run -e esp32-s3-devkitc-1 -t upload --upload-port tb3.local`
Expected: espota transfers the image and the device reboots into it. Mid-program, the transfer is refused (onStart aborts) and `GET /api/ota` shows `"error"`.

- [ ] **Step 7: Commit**

```bash
git add src/tb3_ota.h src/tb3_ota.cpp src/tb3_web.cpp platformio.ini
git commit -m "feat: espota (ArduinoOTA) update path on a core-0 task"
```

---

## Task 6: Rollback (dual-image confirmation)

**Files:**
- Modify: `src/tb3_ota.h` (declare hooks + health calls)
- Modify: `src/tb3_ota.cpp` (weak-hook overrides + mark-valid)
- Modify: `src/TB3_Black_109_Release1.ino` (`setup()` end + `loop()` health tick)

**Interfaces:**
- Produces:
  - `bool verifyRollbackLater();` — overrides the Arduino core weak hook, returns `true` to defer confirmation past `initArduino()`.
  - `void tb3_ota_mark_setup_done();` — call at the end of `setup()`.
  - `void tb3_ota_health_tick();` — call each `loop()`; after ~30 s of healthy uptime it confirms the running image.

- [ ] **Step 1: Declare the rollback API in `tb3_ota.h`**

Add before `#endif // ESP32`:

```cpp
void tb3_ota_mark_setup_done();   // call at end of setup()
void tb3_ota_health_tick();       // call every loop(); confirms image when healthy
```

- [ ] **Step 2: Implement the overrides in `tb3_ota.cpp`**

Add this include at the top of `src/tb3_ota.cpp`:

```cpp
#include <esp_ota_ops.h>
```

Add before `#endif // ESP32`:

```cpp
// Defer the Arduino core's automatic OTA confirmation (esp32-hal-misc.c) so
// WE decide when a freshly-flashed image is trustworthy. Without this, a new
// image is marked valid before setup() even runs and rollback never triggers.
extern "C" bool verifyRollbackLater() { return true; }

static bool s_setup_done = false;
static uint32_t s_setup_done_ms = 0;
static bool s_img_confirmed = false;

void tb3_ota_mark_setup_done() {
  s_setup_done = true;
  s_setup_done_ms = millis();
}

void tb3_ota_health_tick() {
  if (s_img_confirmed || !s_setup_done) return;
  // Health signals: setup() finished, web+AP up (SoftAP always has an IP once
  // begun), and ~30s of loop() elapsed without a reset.
  if (WiFi.softAPIP() == IPAddress((uint32_t)0)) return;
  if (millis() - s_setup_done_ms < 30000) return;
  const esp_partition_t *running = esp_ota_get_running_partition();
  esp_ota_img_states_t st;
  if (esp_ota_get_state_partition(running, &st) == ESP_OK &&
      st == ESP_OTA_IMG_PENDING_VERIFY) {
    esp_ota_mark_app_valid_cancel_rollback();
  }
  s_img_confirmed = true;   // also covers the USB-flashed / already-valid case
}
```

- [ ] **Step 3: Call the health hooks from the firmware**

In `src/TB3_Black_109_Release1.ino`, at the very end of `setup()` (just before the closing `} //end of setup` at line 949), inside the existing ESP32 block:

```cpp
#if defined(ESP32)
tb3_web_begin();
tb3_gamepad_begin();
tb3_ota_mark_setup_done();
#endif
```

And in `loop()`, inside the `while(1)` just after the ESP32 `delay(1);` (line 954):

```cpp
    #if defined(ESP32)
    delay(1);
    tb3_ota_health_tick();
    #endif
```

Add `#include "tb3_ota.h"` alongside the `tb3_lcd_ui.h` include added in Task 2 Step 5:

```cpp
#if defined(ESP32)
#include "tb3_lcd_ui.h"
#include "tb3_ota.h"
#endif
```

- [ ] **Step 4: Build**

Run: `pio run -e esp32-s3-devkitc-1`
Expected: `SUCCESS`.

- [ ] **Step 5: Flash the rollback-capable firmware over USB**

Run: `pio run -e esp32-s3-devkitc-1 -t upload`
This USB image is the first known-good, rollback-capable slot.

- [ ] **Step 6: Verify a good OTA is kept**

OTA a normally-built image (browser or espota). Let it run >30 s. Then power-cycle and confirm it stays on the new image (it was marked valid). `curl http://10.31.31.1/api/info` shows the expected build time.

- [ ] **Step 7: Verify a bad image rolls back**

Temporarily make a knowingly-broken image: at the very top of `setup()` add `#if defined(ESP32)\nabort();\n#endif`, build **only** (`pio run -e esp32-s3-devkitc-1`), then OTA that `.bin`. The device flashes it, reboots into it, `abort()`s before confirming, and on the following reset the bootloader reverts to the previous slot. Confirm the device returns, is reachable at `http://10.31.31.1/`, and still accepts a good OTA. Then revert the deliberate `abort()` edit and rebuild.

- [ ] **Step 8: Commit**

```bash
git add src/tb3_ota.h src/tb3_ota.cpp src/TB3_Black_109_Release1.ino
git commit -m "feat: OTA rollback — defer image confirmation until proven healthy"
```

---

## Task 7: Documentation

**Files:**
- Modify: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Update the Web API table and add an OTA/LCD section**

In `README.md`, add these rows to the Web API table:

```markdown
| GET | `/api/program` | — | `{current, names[8], selectable}` — top-menu programs and which is active |
| POST | `/api/program` | `{"type":0..7,"select":true}` | select/enter a program; 409 unless at the top menu |
| GET | `/api/ota` | — | `{state, progress, error, safe}` — update status |
| POST | `/api/ota` | multipart `firmware=@firmware.bin` | flash a new image; refused (busy) while a program runs or a motor moves |
```

Add a new section after "Web interface":

```markdown
## Firmware updates (OTA)

Two ways, sharing one safety gate — updates are refused while a program is
engaged or any motor is moving, and the 40 kHz step ISR is stopped during the
flash write:

- **Browser:** the "Firmware Update" card uploads a `firmware.bin` with a live
  progress bar. Scriptable:
  `curl -F 'firmware=@.pio/build/esp32-s3-devkitc-1/firmware.bin' http://10.31.31.1/api/ota`
- **espota:** `pio run -e esp32-s3-devkitc-1 -t upload --upload-port tb3.local`
  (uncomment the `upload_protocol = espota` lines in `platformio.ini`).

The two 6.5 MB app slots in `default_16MB.csv` mean updates need no partition
change. **Rollback is enabled:** a freshly-flashed image is only confirmed
after it runs healthily for ~30 s; if it crashes, hangs, or boot-loops before
then, the bootloader reverts to the previous slot on the next reset. A power
cut inside that ~30 s window also rolls back — expected and safe.

## LCD display

- **Idle (top menu):** line 1 is the selected program (change it with up/down
  or the web Program card); line 2 cycles every ~3 s between `UpDown C-Select`,
  the AP address (10.31.31.1), and — when joined to WiFi — the LAN address.
- **Running:** the screen alternates every ~3 s between the classic
  shots/phase + time/battery page and a page showing program type, live phase,
  and pan/tilt in degrees.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: OTA, program picker, and LCD rotation"
```

---

## Self-Review Notes

- **Spec coverage:** idle rotation (T2), run rotation (T2), pure formatters + host tests (T1), browser OTA (T4), espota (T5), safety gate + ISR stop (T4 glue), rollback (T6), web program picker (T3), README (T7). All spec sections map to a task.
- **No `AP`/`STA` prefix:** honored — `tb3_fmt_ip_centered` prints the bare address (T1).
- **Type consistency:** `Tb3UiState` field names are identical across `tb3_lcd_pages.h`, the test, and `tb3_ui_get_state()`. `tb3_ota_state()`/`tb3_ota_progress()`/`tb3_ota_error()` names match between header, `.cpp`, and the `/api/ota` handler. Glue names (`tb3_program_*`, `tb3_ota_safe_to_flash`, `tb3_ota_prepare`, `tb3_ui_*`) are declared in `tb3_web.h` and defined in `TB3_WebGlue.ino`.
- **Non-thread-safe LCD:** all `lcd.*` access is via `tb3_ui_write_line` called only from `tb3_lcd_tick()` (loopTask). The espota/telemetry tasks never touch the LCD.
```
