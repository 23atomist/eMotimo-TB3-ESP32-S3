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

static void tb3_lcd_tick_body() {
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
  bool flipped = (now - s_flip >= PAGE_MS);
  if (flipped) {
    s_page ^= 1; s_flip = now;
    s_last1[0] = s_last2[0] = 0;           // force full repaint on flip
  }
  if (s_page == 0) {
    // Page 0 is the classic status screen painted by display_status(), which
    // the firmware otherwise calls only at shot-completion events. Repaint it
    // on the flip INTO page 0 so the rotation actually alternates. The
    // re-entrancy guard in tb3_lcd_tick() makes the display_status() ->
    // NunChuckQuerywithEC() -> tb3_lcd_tick() call chain safe.
    if (flipped) tb3_ui_repaint_status_page();
    return;
  }
  char l1[17], l2[17];
  tb3_fmt_run_page2_l1(l1, s);
  tb3_fmt_run_page2_l2(l2, s);
  writeLine(1, l1, s_last1);
  writeLine(2, l2, s_last2);
}

void tb3_lcd_tick() {
  static bool in_tick = false;
  if (in_tick) return;          // display_status() -> NunChuckQuerywithEC() -> re-entry
  in_tick = true;
  tb3_lcd_tick_body();
  in_tick = false;
}

#endif // ESP32
