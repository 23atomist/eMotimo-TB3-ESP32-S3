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
