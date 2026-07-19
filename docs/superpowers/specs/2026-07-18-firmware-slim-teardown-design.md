# Firmware Slim-Down / On-Device-UI Teardown — Design

**Status:** approved design, pre-implementation
**Branch:** `feat/firmware-slim` (stacked on `feat/imu-foundation`)
**Goal:** Recover heap (currently ~7.5 KB free, which broke the IMU `/api/imu` large-burst endpoint) and reduce the firmware to a **web/MCP-only** controller by removing the BLE gamepad and the entire on-device UI (LCD + button/menu state machine + standalone program modes), while preserving all web/MCP-driven motion.

## Why

The ESP32-S3 firmware runs out of heap because NimBLE (the BLE gamepad stack) holds tens of KB, on top of WiFi + async + the IMU buffers. Removing BLE recovers ~40–80 KB — far more than the IMU needs. Separately, the LCD hardware is dead and the operator drives everything via web jog + MCP (goto/home/Track-Web tracking), so the on-device menu UI and standalone program modes (PANO, 2pt/3pt moves, Setup, InShoot, Dragonframe-slave) are dead weight woven into the motion loop.

## The central architectural constraint

`loop()` (`TB3_Black_109_Release1.ino:970`) is a `switch(progstep)` state machine. **Web/MCP motion is serviced only when the loop is parked on a handler that calls `NunChuckQuerywithEC()` → `tb3_web_poll()`.** Today, when idle, that handler is `Choose_Program()` (`_TB3_LCD_Buttons.ino:30`) — the on-device menu being deleted. And the MCP tracking mode `Web_Track_Mode()` (`_TB3_LCD_Buttons.ino:240-366`) physically lives inside the file being deleted, reachable only through that menu.

Therefore the teardown must **re-home the web-motion + track logic into a keep module and give the loop a UI-independent dispatcher, BEFORE deleting the menu/LCD/programs.** Deleting the UI first would kill web jog, goto, and tracking.

Two confirmations in our favor (from the coupling map):
- **No physical input exists on the ESP32** — all button/Nunchuck reads are compiled out (`#if !defined(ESP32)`); every input is the virtual `g_usb_*` joystick fed by web/BLE/USB-host/Serial. Web/MCP-only costs nothing.
- **EEPROM/calibration is independent of the Setup menu** — boot restore runs in `setup()` (`:893-904`); the Setup menu only edits settings. Removing it preserves calibration/offsets.

## Keep

- **Core loop / entry:** `TB3_Black_109_Release1.ino` `setup()`+`loop()` shell, all `#define`s/globals (`progtype`, `progstep`, `Program_Engaged`, `WEBTRACK`=8, motor params).
- **Input + velocity engine:** `TB3_Nunchuck.ino` — `NunChuckQuerywithEC()` (ESP32 body `:64-126`), `NunChuckjoybuttons()`, `axis_button_deadzone()`, `calibrate_joystick()`, USB-gamepad callback, `updateMotorVelocities2()` (jog cubic curve `:497`).
- **Web server + glue:** `tb3_web.{cpp,h}` (all `/api/*`, `tb3_web_poll`, `tb3_web_pump_during_move`, `PROGRAM_NAMES[]`), `TB3_WebGlue.ino` (`tb3_get_status`, `tb3_request_stop`, `tb3_cam_write`, `tb3_goto_safe/set_home/goto_execute`, `tb3_program_*`, `tb3_track_ip_line`, OTA hooks).
- **Motion / stepper / ISR (all LCD-free):** `TB_DF.ino` motion engine (`DFSetup`, `onTimer` ISR, `updateMotorVelocities`, `setPulsesPerSecond`, `hardStop`, `synched3PtMove_max`, `synched3AxisMove_timed`), `TB3_Stepper.ino`, `TB3_IO_ISR.ino`, `TB3_Motor_Control.ino` (motor structs / `move_motors` / `sync_isr_steps`), `TB3_Camera_Control.ino`.
- **Persistence / config:** `TB3_EEPROM.ino`.
- **Subsystems:** `tb3_imu.{cpp,h}`, `tb3_ota.{cpp,h}`.
- **Extracted into a new keep module** (currently mis-located in the CUT file): `Web_Track_Mode()` (`_TB3_LCD_Buttons.ino:240-366`), `Check_Prog()` (`TB3_InShootMenu.ino:22`), and the nav helpers `progstep_forward/backward/goto()` (`_TB3_LCD_Buttons.ino:1587-1613`).

## Cut

- **BLE gamepad:** `tb3_gamepad.{cpp,h}`, the `h2zero/NimBLE-Arduino` lib_dep, `tb3_gamepad_begin()` call, `/api/bt` endpoints + the `bt` telemetry object (tick + `/api/status`) + `tb3_gamepad_name/connected/pairing` calls. Keep the `g_usb_*` globals (they're in the main `.ino`, driven by the web path).
- **On-device UI:** `_TB3_LCD_Buttons.ino` (2227 lines, the menu/button state machine) minus the extracted keep functions; `NHDLCD9.{cpp,h}` (LCD driver); `tb3_lcd_ui.{cpp,h}` (`tb3_lcd_tick` page rotator); `tb3_lcd_pages.{cpp,h}` (keep only `tb3_fmt_ip_centered`, used by `tb3_track_ip_line`).
- **Standalone programs:** `TB3_PANO.ino`, `TB3_Setup.ino`, `TB3_InShootMenu.ino` (minus `Check_Prog`), the Dragonframe-slave program in `TB_DF.ino` (keep the motion engine), and the 2pt/3pt program loop `case`s + handlers in `_TB3_LCD_Buttons.ino` and the main `.ino`.

## Entanglements to sever (the exact cut-points)

1. **LCD tick inside the input reader:** `NunChuckQuerywithEC()` calls `tb3_lcd_tick()` at `TB3_Nunchuck.ino:124` — runs every jog/goto/track pass. Remove this line.
2. **Track lives in the CUT file:** extract `Web_Track_Mode()` + `Check_Prog()` + `progstep_*()` into a keep module; strip their `lcd.*`/`draw()` calls; `progstep_goto()` calls `lcd.empty()` (`:1608`).
3. **Track entry is menu-only:** `button_actions_choose_program()` case `WEBTRACK` (`:149-151`) is the only caller. Replace with loop dispatch of `Web_Track_Mode()` when `progtype==WEBTRACK` (settable via `/api/program` → `tb3_program_set_type()`).
4. **Idle `progstep` states pump the web poll:** loop `case 0/100/200/210/300` call `Choose_Program()` which calls `NunChuckQuerywithEC()`. The replacement idle handler **must** call `NunChuckQuerywithEC()` + `axis_button_deadzone()` + `updateMotorVelocities2()` every pass, or goto/jog is never serviced.
5. **WebGlue reaches into LCD:** `tb3_get_lcd()`→`lcd.getShadow()` (`:33`, consumed by the web status endpoint), `tb3_ui_write_line()`→`lcd.at()` (`:83`), `tb3_ui_repaint_status_page()`→`display_status()` (`:89`). Stub `tb3_get_lcd()` to empty strings; delete the other two with `tb3_lcd_ui`.
6. **Boot-time LCD in `setup()`:** `lcd.setup/contrast/cursorOff/bright/empty/at`+`draw()` at `:867-940`. Remove/stub.
7. **`Check_Prog()` shared KEEP/CUT:** LCD-free; relocate to the keep module.
8. **DFSetup vs DFloop share `TB_DF.ino`:** cut the DF-slave program, keep the motion-engine functions.

## Staged execution

Each stage builds clean, flashes, and is **hardware-verified** (web jog + `/api/goto` + `/api/home` + `/api/stop` + Track(Web) + `/api/imu` all work) before the next.

1. **Remove BLE gamepad** — clean, isolated; recovers heap immediately (unblocks the IMU). Verify jog/goto/IMU + free heap jumps (via `/api/status` `heap`).
2. **Extract** `Web_Track_Mode` + `Check_Prog` + `progstep_*` into a new keep module (`tb3_web_motion.ino` or similar) — *no behavior change*, LCD calls left intact for now. Verify Track still works via the menu.
3. **Add a UI-independent idle/track dispatcher** in `loop()`: pump `NunChuckQuerywithEC()` + `axis_button_deadzone()` + `updateMotorVelocities2()` every idle pass; run `Web_Track_Mode()` when `progtype==WEBTRACK`. **← critical gate:** verify web jog/goto/track with the menu never entered.
4. **Sever** `tb3_lcd_tick()` at `TB3_Nunchuck.ino:124`. Retest.
5. **Cut** standalone programs + menu state machine (`TB3_PANO`, `TB3_Setup`, `TB3_InShootMenu` minus `Check_Prog`, DF-slave program, 2pt/3pt `case`s + handlers, `_TB3_LCD_Buttons` keep-emptied). Confirm EEPROM restore still runs. Retest.
6. **Cut** the LCD subsystem (`NHDLCD9`, `tb3_lcd_ui`, `tb3_lcd_pages` minus `tb3_fmt_ip_centered`), stub the WebGlue LCD glue, strip LCD from `setup()` and the extracted track/nav code. Final full web/MCP regression + heap check.

## Guardrails

- Keep `WEBTRACK`=8 and `PROGRAM_NAMES[]`/`MENU_OPTIONS` index-aligned (EEPROM- and picker-load-bearing: `TB3_Black_109_Release1.ino:246-250`, `tb3_web.cpp:471`).
- Never remove `NunChuckQuerywithEC()` from the active `progstep` path.
- Keep `tb3_web_pump_during_move()` in `tb3_goto_execute()`'s loop so `/api/stop` still lands mid-goto.
- Re-partitioning is **out of scope** (it's flash layout; it does not recover heap). Flash is ~22% used.

## Success criteria

1. Firmware builds clean; free heap (`/api/status` `heap`) rises from ~7.5 KB to tens of KB after Stage 1.
2. After every stage, on hardware: web jog moves, `/api/goto` + `/api/home` + `/api/stop` work, Track(Web) tracking works, `/api/imu` reads the sensor.
3. Final firmware: no NimBLE, no LCD driver, no on-device menus/programs; web + MCP control fully intact; `/api/imu` large bursts (n up to the cap) transmit reliably now that heap is healthy.
4. EEPROM-stored calibration/offsets survive across the teardown.
