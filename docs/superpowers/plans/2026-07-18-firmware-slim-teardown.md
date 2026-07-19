# Firmware Slim-Down / On-Device-UI Teardown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **This is firmware with NO unit-test harness. Each task's gate is: (1) `pio run` builds clean, and (2) a hardware verification checklist run by the controller + human on the physical rig (flash via OTA, confirm web motion + IMU still work). Do not mark a task complete until BOTH pass. The hardware step is interactive — a subagent does the edits + build; the controller/human does the flash + verify between tasks.**

**Goal:** Reduce the TB3 ESP32-S3 firmware to a web/MCP-only controller — remove the BLE gamepad and the entire on-device UI (LCD + menu state machine + standalone program modes) — recovering ~40–80 KB of heap while preserving all web/MCP-driven motion.

**Architecture:** In-place staged teardown. The motion engine (stepper ISR, velocity curve, coordinated moves) is battle-tested and hardware-tuned — it stays untouched. We first re-home the web-motion/track logic out of the doomed menu file into a keep module and give `loop()` a UI-independent dispatcher, THEN delete the menu/LCD/programs. Each stage is flashed and hardware-verified before the next.

**Tech Stack:** Arduino/ESP32-S3 C++, PlatformIO (`esp32-s3-devkitc-1`), ESPAsyncWebServer, ArduinoJson. `.ino` files are concatenated into one translation unit (globals are shared implicitly).

## Global Constraints

- **Build (every task):** `export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && cd /Volumes/ExtData2/coding/TB3-ESP32 && pio run -e esp32-s3-devkitc-1` → `[SUCCESS]`.
- **Hardware verify (every task):** flash `.pio/build/esp32-s3-devkitc-1/firmware.bin` via OTA (`curl -F "firmware=@..." http://<IP>/api/ota`; rig at DHCP ~`192.168.4.56`; OTA is slow ~60–70 s and a terminal `curl: (56)` reset = the post-flash restart = SUCCESS; confirm the new `build` date in `/api/info`). Then confirm on hardware: **web jog moves; `/api/goto` moves + arrives; `/api/home`; `/api/stop` stops a jog; Track(Web) tracking works; `/api/imu?n=5` reads the sensor.** Task 1 additionally checks `/api/status` `heap` jumped.
- **Preserve the `g_usb_*` virtual-joystick globals** (`TB3_Black_109_Release1.ino:92-96`) — the web jog writes them; they are NOT part of the gamepad file.
- **Guardrails (every task):** keep `WEBTRACK`=8 and `PROGRAM_NAMES[]` (`tb3_web.cpp:471`) / `MENU_OPTIONS` index-aligned (EEPROM- and picker-load-bearing); never remove `NunChuckQuerywithEC()` from the active `progstep` path; keep `tb3_web_pump_during_move()` in `tb3_goto_execute()`'s move loop so `/api/stop` lands mid-goto.
- **Motion engine is off-limits:** do not modify the stepper ISR (`TB3_IO_ISR.ino`, `onTimer`), the velocity curve (`updateMotorVelocities2`), `TB3_Stepper.ino`, or the coordinated-move functions in `TB_DF.ino`. Only remove the *DF-slave program*, never the motion functions.
- **Daemon:** no changes in this plan. The daemon already selects Track(Web) via `/api/program` and streams — that contract is preserved.
- **Re-partitioning: out of scope** (flash layout; doesn't help heap).

---

## File Structure

- **Create:** `src/tb3_web_motion.ino` — new keep module holding the extracted `Web_Track_Mode()`, `Check_Prog()`, `progstep_forward/backward/goto()`, and (Task 3) the `tb3_idle_dispatch()` UI-independent loop handler.
- **Modify:** `TB3_Black_109_Release1.ino` (loop dispatch, setup LCD, `tb3_gamepad_begin` call), `tb3_web.cpp` (drop `/api/bt` + `bt` telemetry), `TB3_Nunchuck.ino` (drop `tb3_lcd_tick`), `TB3_WebGlue.ino` (stub LCD glue), `platformio.ini` (drop NimBLE), `TB_DF.ino` (drop DF-slave program only).
- **Delete:** `tb3_gamepad.{cpp,h}`, `_TB3_LCD_Buttons.ino`, `TB3_PANO.ino`, `TB3_Setup.ino`, `TB3_InShootMenu.ino` (after moving `Check_Prog`), `NHDLCD9.{cpp,h}`, `tb3_lcd_ui.{cpp,h}`, `tb3_lcd_pages.{cpp,h}` (after moving `tb3_fmt_ip_centered`).

The exact entanglement cut-points (file:line) are in the spec's "Entanglements to sever" section — read it before Task 2.

---

## Task 1: Remove the BLE gamepad

**Files:**
- Delete: `src/tb3_gamepad.cpp`, `src/tb3_gamepad.h`
- Modify: `platformio.ini` (drop `h2zero/NimBLE-Arduino`), `src/TB3_Black_109_Release1.ino` (remove `tb3_gamepad_begin();` call ~`:963` and any `#include "tb3_gamepad.h"`), `src/tb3_web.cpp` (remove the `/api/bt` GET + POST handlers, the `bt` object in `buildTick` and `/api/status`, and the `tb3_gamepad_name/connected/pairing` calls; also remove `#include "tb3_gamepad.h"` if present)

**Interfaces:**
- Consumes: nothing. Produces: nothing (pure removal). KEEP the `g_usb_*` globals in the main `.ino` (`:92-96`) — they are written by the web jog path and read by `NunChuckQuerywithEC`.

- [ ] **Step 1: Delete the gamepad files**
```bash
git rm src/tb3_gamepad.cpp src/tb3_gamepad.h
```

- [ ] **Step 2: Drop the NimBLE dependency**
In `platformio.ini`, remove the line `  h2zero/NimBLE-Arduino@^2.3.2` from `lib_deps`.

- [ ] **Step 3: Remove the init call + include**
In `src/TB3_Black_109_Release1.ino`: delete `tb3_gamepad_begin();` (the line after `tb3_web_begin();`/`tb3_gamepad_begin();` in `setup()`, ~`:963`) and any `#include "tb3_gamepad.h"`.

- [ ] **Step 4: Remove the BT web surface**
In `src/tb3_web.cpp`:
- Delete the `s_server.on("/api/bt", HTTP_GET, ...)` handler and the `AsyncCallbackJsonWebHandler("/api/bt", ...)` POST handler.
- In `buildTick` (`~:117-146`): remove the `bt` object from the JSON and the `tb3_gamepad_connected/name/pairing` args + the `char btn[...]` line and its `jsonEscapeInto`.
- In `/api/status` (`~:209-212`): remove the `JsonObject bt = d["bt"]...` block.
- Remove `#include "tb3_gamepad.h"`.
(Compile errors will pinpoint any remaining `tb3_gamepad_*` reference — remove each.)

- [ ] **Step 5: Build**
Run the Global-Constraints build. Expected `[SUCCESS]`. Fix any dangling `tb3_gamepad_*` / NimBLE reference until clean.

- [ ] **Step 6: Hardware verify**
Flash + run the Global-Constraints hardware checklist. **Additionally: `/api/status` `heap` must jump from ~7.5 KB to tens of KB** (this is the whole point — record the before/after). Confirm `/api/imu?n=200` now transmits fully (the heap headroom fixes the earlier stall).

- [ ] **Step 7: Commit**
```bash
git add -A && git commit -m "slim: remove BLE gamepad (NimBLE) — recovers heap"
```

---

## Task 2: Extract the keep-critical code out of the doomed menu file

**Files:**
- Create: `src/tb3_web_motion.ino`
- Modify: `src/_TB3_LCD_Buttons.ino` (remove the moved functions), `src/TB3_InShootMenu.ino` (remove `Check_Prog`)

**Interfaces:**
- Produces (for Task 3): `void Web_Track_Mode()`, `void Check_Prog()`, `void progstep_forward()`, `void progstep_backward()`, `void progstep_goto(int)` — moved verbatim, same signatures. Consumes the motion/LCD globals already shared across the `.ino` unit.

- [ ] **Step 1: Create the keep module and move the functions verbatim**
Create `src/tb3_web_motion.ino`. **Move (cut-paste, unchanged)** these functions into it:
- `Web_Track_Mode()` — from `_TB3_LCD_Buttons.ino:240-366`.
- `progstep_forward()`, `progstep_backward()`, `progstep_goto(int)` — from `_TB3_LCD_Buttons.ino:1587-1613`.
- `Check_Prog()` — from `TB3_InShootMenu.ino:22` (its full body).
Leave their `lcd.*`/`draw()` calls intact for now (Task 6 strips them). Delete the originals from their source files. Wrap the file body in `#if defined(ESP32) ... #endif` (matching `Web_Track_Mode`'s existing guard).

- [ ] **Step 2: Build**
Expected `[SUCCESS]`. A duplicate-definition or missing-symbol error means a function was copied but not deleted from the origin, or vice-versa — fix until clean. (Because `.ino` files concatenate, the moved functions keep seeing the same globals; no new externs needed.)

- [ ] **Step 3: Hardware verify — NO behavior change**
Flash + full checklist. This task must not change behavior: **Track(Web) still works the same way it does today (selected via the on-device menu OR via `/api/program`), and web jog/goto/home/stop are unchanged.** This de-risks Task 3.

- [ ] **Step 4: Commit**
```bash
git add -A && git commit -m "slim: extract Web_Track_Mode/Check_Prog/progstep helpers to tb3_web_motion (no behavior change)"
```

---

## Task 3: UI-independent idle/track dispatcher (CRITICAL GATE)

**Files:**
- Modify: `src/tb3_web_motion.ino` (add `tb3_idle_dispatch()`), `src/TB3_Black_109_Release1.ino` (loop `case 0` calls it)

**Interfaces:**
- Consumes: `Web_Track_Mode()` (Task 2), `NunChuckQuerywithEC()`, `axis_button_deadzone()`, `updateMotorVelocities2()`, `startISR1()`, `tb3_ota_state()`, `nextMoveLoaded`, `progtype`, `WEBTRACK`. Produces: `void tb3_idle_dispatch()`.

- [ ] **Step 1: Add the dispatcher**
In `src/tb3_web_motion.ino`, add:
```cpp
// The idle handler for a menu-less firmware. Runs once per loop() pass.
// Non-track: a web servo — on first entry DFSetup() ENABLES the motors
// (enable_PT/enable_AUX; boot leaves MOTOR_EN HIGH/disabled) and resets the
// motion state, exactly as Web_Track_Mode does at entry — WITHOUT this the
// velocity engine pumps against dead drivers and nothing moves. Then re-assert
// the step ISR (a prior goto ends with stopISR1(), and onTimer() is the only
// writer that clears nextMoveLoaded, so without this a completed goto latches
// jog/web-input dead) and pump the web input (NunChuckQuerywithEC drains
// /api/goto and /api/joy via tb3_web_poll). Track: delegate to Web_Track_Mode(),
// re-arming the one-time init so returning from a track session re-enables the
// motors. The ISR re-assert is skipped while an OTA is actually flashing.
void tb3_idle_dispatch() {
#if defined(ESP32)
  static bool s_idle_ready = false;
  if (progtype == WEBTRACK) { s_idle_ready = false; Web_Track_Mode(); return; }
  if (!s_idle_ready) {
    DFSetup();               // enable motors + reset motion state (like Web_Track_Mode entry)
    NunChuckQuerywithEC();   // clear any stale button registry
    s_idle_ready = true;
  }
  if (tb3_ota_state() != TB3_OTA_RUNNING) startISR1();
  if (!nextMoveLoaded) {
    NunChuckQuerywithEC();
    axis_button_deadzone();
    updateMotorVelocities2();
  }
#endif
}
```

- [ ] **Step 2: Point the loop's idle case at it**
In `src/TB3_Black_109_Release1.ino`, in `loop()`'s `switch(progstep)`, change `case 0:` to call `tb3_idle_dispatch();` instead of `Choose_Program();`. Leave the other cases for now (removed in Task 5). Because `Web_Track_Mode()` on exit calls `progstep_goto(0)` and `progtype` stays `WEBTRACK`, that path would immediately re-enter tracking — acceptable for daemon-driven tracking (the daemon leaves the mode by selecting a different `progtype` via `/api/program`; the human C+Z exit is now vestigial). Do NOT add menu re-entry logic.

- [ ] **Step 3: Build** — expected `[SUCCESS]`.

- [ ] **Step 4: Hardware verify — THE CRITICAL GATE**
Flash + full checklist, and specifically confirm **web jog + `/api/goto` + `/api/home` + `/api/stop` all work with the on-device menu NEVER entered** (the rig boots to `progstep 0` → `tb3_idle_dispatch`, not the menu), and **Track(Web) works when selected via `/api/program` type=8** (daemon path). If web jog does not move here, STOP — the dispatcher isn't pumping `NunChuckQuerywithEC` on the active path; do not proceed to deletions.

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "slim: UI-independent idle/track dispatcher — web motion no longer needs the menu"
```

---

## Task 4: Sever the LCD tick from the input reader

**Files:** Modify `src/TB3_Nunchuck.ino`

- [ ] **Step 1: Remove the LCD tick**
In `src/TB3_Nunchuck.ino`, delete the `tb3_lcd_tick();` call at `:124` (inside `NunChuckQuerywithEC()`). This is the LCD page rotator running every motion pass; it is the last live coupling from the input reader into the LCD subsystem.

- [ ] **Step 2: Build** — expected `[SUCCESS]` (the symbol still exists until Task 6; this just stops calling it).

- [ ] **Step 3: Hardware verify** — full checklist. Jog/goto/track unaffected.

- [ ] **Step 4: Commit**
```bash
git add -A && git commit -m "slim: stop calling tb3_lcd_tick from the input reader"
```

---

## Task 5: Cut the standalone programs + menu state machine

**Files:**
- Delete: `src/TB3_PANO.ino`, `src/TB3_Setup.ino`, `src/TB3_InShootMenu.ino`, `src/_TB3_LCD_Buttons.ino`
- Modify: `src/TB_DF.ino` (remove the DF-slave *program* only), `src/TB3_Black_109_Release1.ino` (remove the dead `switch(progstep)` cases + their handler declarations)

**Interfaces:**
- Consumes: nothing new. Produces: nothing. This is the bulk removal. `Web_Track_Mode`/`Check_Prog`/`progstep_*` are already safe in `tb3_web_motion.ino` (Task 2); `tb3_idle_dispatch` is the only idle path (Task 3).

- [ ] **Step 1: Delete the program + menu files**
```bash
git rm src/TB3_PANO.ino src/TB3_Setup.ino src/TB3_InShootMenu.ino src/_TB3_LCD_Buttons.ino
```

- [ ] **Step 2: Remove the DF-slave program from `TB_DF.ino`**
In `src/TB_DF.ino`, remove the Dragonframe-slave *program* function(s) (`DFloop`/`DFSlave` — the ones invoked from the old menu at `_TB3_LCD_Buttons.ino:147`). **KEEP** the motion-engine functions: `DFSetup()`, `onTimer()`, `updateMotorVelocities()`, `setPulsesPerSecond()`, `hardStop()`, `synched3PtMove_max()`, `synched3AxisMove_timed()`. If unsure whether a function is engine or program, keep it and let Step 4's compile flag unused-but-referenced issues.

- [ ] **Step 3: Gut the dead loop cases**
In `src/TB3_Black_109_Release1.ino`'s `loop()` `switch(progstep)`: remove every `case` except `case 0:` (now `tb3_idle_dispatch()`), and the `default:` if present. The removed cases (1-9, 50-52, 90, 100-109, 200-217, 250, 290, 300-308, 901-908, etc.) dispatched to handlers in the just-deleted files. Also remove any now-unused function prototypes/`extern`s for those handlers at the top of the file.

- [ ] **Step 4: Build — iterate on the compile errors**
Expected: the build will surface every remaining reference to a deleted function (menu handlers, `Choose_Program`, `display_status`, PANO/Setup/InShoot entry points, `go_to_start_new`/`go_to_origin_slow` in `TB3_Motor_Control.ino` if they're only called by deleted programs). Remove each dead reference. Do NOT remove anything on the KEEP list (Global Constraints / spec). Repeat until `[SUCCESS]`.

- [ ] **Step 5: Hardware verify**
Flash + full checklist. **Additionally confirm EEPROM-restored settings survived:** the rig should behave with the same jog scaling / calibration as before (boot restore in `setup()` `:893-904` is untouched). Track(Web) via `/api/program` type=8 still works.

- [ ] **Step 6: Commit**
```bash
git add -A && git commit -m "slim: remove standalone programs + on-device menu state machine"
```

---

## Task 6: Cut the LCD subsystem

**Files:**
- Delete: `src/NHDLCD9.cpp`, `src/NHDLCD9.h`, `src/tb3_lcd_ui.cpp`, `src/tb3_lcd_ui.h`, `src/tb3_lcd_pages.cpp`, `src/tb3_lcd_pages.h`
- Modify: `src/TB3_WebGlue.ino` (stub LCD glue), `src/TB3_Black_109_Release1.ino` (strip LCD from `setup()`), `src/tb3_web_motion.ino` (strip `lcd.*`/`draw()` from the extracted code), `src/tb3_web.cpp` (`tb3_get_lcd` consumers)

**Interfaces:**
- Keep `tb3_fmt_ip_centered()` (used by `tb3_track_ip_line`) by relocating it into `TB3_WebGlue.ino` before deleting `tb3_lcd_pages`.

- [ ] **Step 1: Relocate the one kept formatter**
Move `tb3_fmt_ip_centered()` (from `tb3_lcd_pages.cpp`) into `src/TB3_WebGlue.ino` (or `tb3_web_motion.ino`), so `tb3_track_ip_line()` still links after `tb3_lcd_pages` is deleted.

- [ ] **Step 2: Stub the WebGlue LCD glue**
In `src/TB3_WebGlue.ino`:
- `tb3_get_lcd(char* line1, char* line2)` (`:13`-ish, calls `lcd.getShadow()`): replace its body with `line1[0]=0; line2[0]=0;` (empty strings — the web status/telemetry endpoint reads this; empty is fine).
- Delete `tb3_ui_write_line()` (`:80-90`, `lcd.at`) and `tb3_ui_repaint_status_page()` (`:89`, calls the deleted `display_status`), plus any calls to them.

- [ ] **Step 3: Strip LCD from `setup()`**
In `src/TB3_Black_109_Release1.ino` `:867-940`: remove `lcd.setup()`, `lcd.contrast/cursorOff/bright/empty/at`, and `draw()` calls. Remove the `NHDLCD9 lcd(4,2,16);` object declaration (`:106`) and `#include "NHDLCD9.h"`.

- [ ] **Step 4: Strip LCD from the extracted track/nav code**
In `src/tb3_web_motion.ino`: in `Web_Track_Mode()` remove the `lcd.empty/bright/at` + `draw(91,...)` calls (`:246-250`, `:312`, `:364`) and the IP-line LCD writes (keep the `tb3_track_ip_line`/`strcmp` logic if you want the IP tracked internally, but drop the `lcd.at` write); in `progstep_goto()` remove the `lcd.empty()` call.

- [ ] **Step 5: Delete the LCD files**
```bash
git rm src/NHDLCD9.cpp src/NHDLCD9.h src/tb3_lcd_ui.cpp src/tb3_lcd_ui.h src/tb3_lcd_pages.cpp src/tb3_lcd_pages.h
```

- [ ] **Step 6: Build — iterate on the compile errors**
Every remaining `lcd.` / `draw(` / `tb3_lcd_*` / `NHDLCD9` reference will surface. Remove/stub each (they're all in CUT or already-stubbed paths). Repeat until `[SUCCESS]`.

- [ ] **Step 7: Hardware verify — final full regression**
Flash + full checklist one more time: web jog, `/api/goto`, `/api/home`, `/api/stop`, Track(Web) via `/api/program`, `/api/imu?n=500` (max burst transmits with the healthy heap), EEPROM settings intact. Record final `/api/status` `heap`.

- [ ] **Step 8: Commit**
```bash
git add -A && git commit -m "slim: remove the LCD subsystem — firmware is now web/MCP-only"
```

---

## Self-Review

**Spec coverage:** BLE removal → Task 1 ✓. Extract Web_Track_Mode/Check_Prog/progstep → Task 2 ✓. UI-independent dispatcher (critical gate) → Task 3 ✓. Sever tb3_lcd_tick → Task 4 ✓. Cut programs+menus (incl. DF-slave, keep engine) → Task 5 ✓. Cut LCD subsystem + stub WebGlue + strip setup() → Task 6 ✓. Keep tb3_fmt_ip_centered → Task 6 Step 1 ✓. Guardrails (WEBTRACK=8, NunChuckQuerywithEC on active path, tb3_web_pump_during_move) → Global Constraints, reasserted in Tasks 3/5 ✓. EEPROM survives → Task 5 Step 5 ✓. Heap recovery → Task 1 Step 6 ✓.

**Placeholder scan:** the removal tasks intentionally say "iterate on the compile errors" rather than enumerate every dead reference — this is correct for a teardown of a concatenated `.ino` unit where the linker is the authoritative list of what's dead; the KEEP list bounds what must survive. The one NEW code block (`tb3_idle_dispatch`) is complete.

**Type consistency:** `Web_Track_Mode()`/`Check_Prog()`/`progstep_forward/backward/goto()` moved verbatim (Task 2), consumed by `tb3_idle_dispatch()` (Task 3), same signatures. `WEBTRACK`=8 and `PROGRAM_NAMES[]` untouched throughout.

**Note for execution:** because every task has an interactive hardware gate, **inline execution (executing-plans) may fit better than subagent-driven** — the controller does each edit+build, then flashes and verifies with the human before the next stage. Subagent-driven also works (subagent does edits+build; controller/human do the flash+verify between tasks), but the per-stage hardware handshake is the real pacing.
