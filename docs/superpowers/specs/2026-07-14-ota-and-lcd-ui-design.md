# TB3 Black ESP32-S3: OTA Updates, LCD Page Rotation, Web Program Picker — Design

Date: 2026-07-14
Status: approved, not yet implemented

## Goal

Three changes to the ESP32-S3 port:

- **OTA firmware updates**, delivered two ways (browser upload and `espota`),
  sharing one `Update.h` code path and one safety gate, with **bootloader-level
  rollback** so a bad image cannot strand the device.
- **A live-rotating 16x2 LCD**, so the panel shows something useful instead of
  a static line:
  - *idle* (top menu): line 2 cycles between the key hint and the device's
    network address, showing whether it is on AP or STA.
  - *running*: the screen alternates between the classic shot/time/battery
    page and a new page showing program type, live phase, and pan/tilt.
- **A program picker in the web UI**, so the 8 top-menu programs can be chosen
  without nudging the virtual joystick blindly.

## Constraints and context

- The 2015 firmware is a large *blocking* state machine. `loop()` switches on
  `progstep` and most screens sit in nested `while` loops. A rewrite is out of
  scope. Anything periodic must hang off a hook those loops already call.
- `NunChuckQuerywithEC()` (`TB3_Nunchuck.ino:64`) is called every input cycle
  from every menu loop *and* from the shoot loop
  (`TB3_Black_109_Release1.ino:1351`, "this portion always runs in empty space
  of loop"). It is already where `tb3_web_poll()` hooks in. It runs in
  loopTask context.
- The LCD (`NHDLCD9` over Serial1/GPIO4, 9600 baud) and its shadow buffer are
  **not thread-safe**. A background task painting the panel would interleave
  bytes with the menus' own writes and corrupt both the panel and the web
  mirror. All LCD writes must stay in loopTask.
- 9600 baud means ~1 ms per character: a full 32-character repaint costs
  ~33 ms. Repainting every loop iteration would visibly stall the menus.
- `default_16MB.csv` already provides `otadata` plus two 6.5 MB app slots
  (`ota_0` at 0x10000, `ota_1` at 0x650000). **No partition change is
  required.** Once this firmware is flashed over USB once, subsequent updates
  can go over the air.
- The stock pioarduino build **already has rollback compiled in** — verified in
  `~/.platformio/packages/framework-arduinoespressif32-libs/esp32s3/sdkconfig`:
  `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y`, `CONFIG_APP_ROLLBACK_ENABLE=y`,
  `CONFIG_BOOTLOADER_WDT_ENABLE=y`, and `libapp_update.a` is linked. No custom
  bootloader and no extra partition are needed to get rollback.
- Conversely, `CONFIG_BOOTLOADER_FACTORY_RESET` and `CONFIG_BOOTLOADER_APP_TEST`
  are **not** set, so a GPIO-triggered boot into a dedicated recovery image is
  not possible without building a custom bootloader. See "Out of scope".
- Flash writes drop the instruction cache. The 40 kHz DFMoco step ISR is not
  IRAM-resident; if it fires during an OTA write, the chip panics. OTA must
  not run while the step engine is live.
- `STEPS_PER_DEG` is `444.444` (`TB3_Black_109_Release1.ino:307`), so
  `current_steps` converts cleanly to degrees.
- Program menu: `MENU_OPTIONS 8`, `progtype` 0..7 — New 2-Pt (0), Rev 2-Pt (1),
  New 3-Pt (2), Rev 3-Pt (3), Panorama (4), Portrait Pano (5), DF Slave (6),
  Setup Menu (7). `AUXDISTANCE` (99) exists but is not reachable from the menu
  and is out of scope.

## Approaches considered

1. **Tick hook in `NunChuckQuerywithEC()`, zone-gated by `progstep`** *(chosen)*
   — one function, loopTask context, no new task, no locking. The tick only
   acts in the two `progstep` zones it owns and is inert everywhere else, so no
   existing screen changes behavior.
2. A dedicated FreeRTOS LCD task — rejected. Requires a mutex around every
   `lcd.*` call in ~11k lines of 2015 firmware, and any missed call site
   silently corrupts the panel.
3. Rewriting `display_status()` and `Choose_Program()` to be page-aware
   internally — rejected. Spreads rotation state across two large legacy files
   and duplicates the timer logic.

## Architecture

### New files

| File | Responsibility |
|---|---|
| `src/tb3_lcd_pages.h/.cpp` | **Pure formatting.** No Arduino dependencies. Renders a `Tb3UiState` into 17-byte line buffers. Unit-testable on the host. |
| `src/tb3_lcd_ui.h/.cpp` | The tick: zone detection, page timer, dirty tracking, LCD writes. |
| `src/tb3_ota.h/.cpp` | `ArduinoOTA` task + the `/api/ota` handlers + the shared safety gate. |

Modified: `tb3_web.cpp` (two new routes), `tb3_ui.h` (two new UI cards),
`TB3_WebGlue.ino` (setter for `.ino`-side globals), `TB3_Nunchuck.ino` (the
tick call), `_TB3_LCD_Buttons.ino` (`display_status()` page guard),
`platformio.ini` (`espota` upload config), `README.md`.

### The LCD tick

`tb3_lcd_tick()` is called from `NunChuckQuerywithEC()`, immediately after the
existing `tb3_web_poll()` call. It reads `progstep` and selects a zone:

- **IDLE** — `progstep` in {0, 100, 200, 210, 300} (every `Choose_Program()`
  entry point). Owns **line 2 only**. Line 1 must stay the program name,
  because that is what up/down is changing.
- **RUN** — `progstep` in {50 (SMS), 51, 52 (external trigger), 250 (Pano)}.
  Owns **both lines**.
- **OTHER** — every other screen (setup, jog, interval, review, …). The tick
  returns immediately and writes nothing.

Zone changes reset the page index to 0 and force a repaint.

### Idle rotation (line 2, ~3 s per page)

```
|New 2 Point Move|   |New 2 Point Move|   |New 2 Point Move|
|UpDown  C-Select|   |   10.31.31.1   |   |  192.168.1.42  |
```

Addresses are printed **bare and centered — no `AP`/`STA` prefix.** The AP is
always 10.31.31.1, so the address itself identifies the interface, and dropping
the prefix means even a 15-character address (`192.168.100.100`) fits the
16-character line without truncation.

Page 3 is only in the rotation when `WiFi.status() == WL_CONNECTED`. With no
STA join, only pages 1 and 2 cycle. `Choose_Program()`'s own `first_time`
redraw paints the page-1 hint, which is consistent with the tick's page 0, so
the two do not fight.

### Run rotation (both lines, ~3 s per page)

```
|  12/ 240 Linea |   |2Pt SMS   Linea |
|00:14:32  12.40v|   |P+42.3   T-11.8 |
```

Page 1 is the existing `display_status()` output, unchanged: shots fired/total,
program phase, time remaining, battery.

Page 2 is new: program type + live phase on line 1, pan and tilt in degrees on
line 2 (`current_steps / STEPS_PER_DEG`, signed, one decimal).

`display_status()` is still called after each shot by the shoot loop. It gains
a one-line guard at the top: if the current run page is not page 1, return
without painting. The tick owns the flip and forces a full repaint on each
flip, so page 1's content is correct whenever it comes back around.

### OTA

Both delivery paths call the same gate and the same `Update` sequence.

- **Web**: `POST /api/ota` — a multipart upload, streamed chunk by chunk into
  `Update.write()` by `AsyncWebServer`'s upload handler (the whole image is
  never buffered in RAM). `GET /api/ota` returns `{state, progress, error}`.
  A card in the web UI provides a file picker and a progress bar.
  Scriptable: `curl -F 'firmware=@firmware.bin' http://10.31.31.1/api/ota`.
- **espota**: `ArduinoOTA`, hostname `tb3`, port 3232, serviced by a task
  pinned to core 0 alongside the existing telemetry task. Enables
  `pio run -t upload --upload-port tb3.local`.

**Safety gate** (`tb3_ota_allowed()`), evaluated before the first byte is
written, in `ArduinoOTA.onStart()` and on the first `/api/ota` chunk:

- refuse if `Program_Engaged` is set;
- refuse if any bit of `motorMoving` is set;
- on refusal, respond with a clear error ("busy — stop the program first") and
  abort the transfer.

There is **no force override.** The user stops the program first.

On accept:

1. `stopISR1()` (already idempotent) halts the 40 kHz step timer.
2. Motors are disabled (`disable_PT()`, `disable_AUX()`).
3. `Update.begin()` … `Update.write()` … `Update.end()`.
4. Progress is published to the LCD (`OTA  45%`) and into the WebSocket tick.
5. Success → `ESP.restart()`. Failure → report the error, restart the step
   engine, and return to normal operation without rebooting.

### Rollback (dual image)

Today, a freshly-OTA'd image is marked valid inside `initArduino()` — *before
`setup()` runs* — because the Arduino core's `verifyOta()` weak hook defaults to
`true` (`cores/esp32/esp32-hal-misc.c:314-329`). That makes rollback almost
useless: only an image that cannot reach `initArduino()` is ever reverted.

We take over the decision by overriding the core's two weak hooks:

```c
bool verifyRollbackLater() { return true; }   // defer past initArduino()
```

`esp_ota_mark_app_valid_cancel_rollback()` is then called by *our* code, once
the new image has demonstrably worked:

- `setup()` ran to completion,
- the web server is up and the SoftAP is answering,
- the step ISR is ticking,
- and ~30 s of `loop()` has elapsed without a reset.

If the image never gets there — panic, interrupt/task watchdog, or boot loop —
the next reset finds `otadata` still in `ESP_OTA_IMG_PENDING_VERIFY`, and the
bootloader marks the image aborted and boots the **other slot**. That slot holds
the previous image, which is by construction a working, OTA-capable firmware.
The recovery path is therefore enforced by the bootloader, not by the app that
just proved it cannot be trusted.

Known cost: a power cut inside that ~30 s post-update window is indistinguishable
from a failure and will roll back. That is why mark-valid keys off positive
health signals and not a bare timer — but the window cannot be eliminated, only
kept short. This is an acceptable trade for an un-brickable update path.

### Web program picker

- `GET /api/program` → `{current: N, names: [...8 names...], selectable: bool}`.
  `selectable` is false unless the device is sitting in a `Choose_Program()`
  `progstep`.
- `POST /api/program {"type": 0..7, "select": true}` →
  - 409 unless the device is in a `Choose_Program()` `progstep`;
  - sets `progtype`, sets `first_time = 1` so the LCD redraws;
  - if `select`, sets `s_btn_c_until = millis() + 80`, so the commit runs
    through the existing virtual C-press path and therefore through the real,
    tested `button_actions_choose_program()` logic rather than a duplicate of
    it.

`progtype` and `first_time` are `.ino`-unit globals, so the setter lives in
`TB3_WebGlue.ino` and is declared in `tb3_web.h` alongside the other
`.ino`-side hooks.

## Error handling

- OTA refused while busy → 409 + JSON error; no flash write attempted.
- OTA write failure (bad image, short upload, flash error) → `Update.abort()`,
  error surfaced on `GET /api/ota` and on the LCD, step engine restarted, no
  reboot. The running slot is untouched, so a failed *write* cannot brick the
  device.
- OTA image that writes cleanly but then crashes, hangs, or boot-loops → the
  bootloader reverts to the previous slot on the next reset (see "Rollback").
  So a bad *image* cannot brick the device either.
- `POST /api/program` outside the top menu → 409, no state change.
- Malformed `type` (outside 0..7) → 400.
- STA address too long for the LCD line → prefix dropped (see above), never
  truncated mid-address.

## Testing

The firmware has no host test harness and most of this is hardware behavior.
The split above exists so that the one genuinely testable part is testable:

- **Host unit tests** (`test/`, native env) over `tb3_lcd_pages.cpp`, which is
  pure and Arduino-free: idle line 2 for AP-only / AP+STA / long-address cases;
  run page 2 for positive, negative, and zero pan/tilt, each program type, and
  each phase; verify every output is exactly 16 characters and NUL-terminated.
- **On-hardware verification** for the rest, and it must be done before this is
  called done:
  - idle rotation cycles AP → STA → hint and back; STA page absent when not
    joined;
  - run rotation alternates both pages during a real SMS shoot, and the classic
    page still updates per shot;
  - every other menu screen is visually unchanged;
  - `pio run -t upload --upload-port tb3.local` completes and the device boots
    the new image;
  - browser upload completes with a live progress bar;
  - OTA is refused mid-program, and accepted after STOP;
  - program picker selects and enters each of the 8 programs.
  - **rollback**, tested deliberately: OTA an image whose `setup()` calls
    `abort()` (or spins in a tight loop with interrupts off), confirm the device
    reboots and comes back running the *previous* firmware, still reachable over
    the network and still able to accept a good OTA.

## Out of scope

- `AUXDISTANCE` (progtype 99) in the picker — unreachable from the menu today.
- A dedicated recovery/factory partition reachable by holding a GPIO at boot.
  The prebuilt Arduino bootloader has `CONFIG_BOOTLOADER_FACTORY_RESET` and
  `CONFIG_BOOTLOADER_APP_TEST` unset, so this would require building and
  maintaining a custom bootloader. Rollback (above) gives the same protection
  for near-zero cost, because the previous slot *is* the recovery image.
- Anti-rollback / signed images (`CONFIG_APP_ANTI_ROLLBACK`, secure boot). Not
  a threat model for a device on its own AP on a film set.
- Any change to the jog, setup, or parameter-entry screens.
