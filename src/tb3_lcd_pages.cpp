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
  const char *type = type_label(s.progtype);
  const char *phase = phase_label(s);
  // "<type> <interval>" as a literal prefix (type is not padded to a fixed
  // width — labels vary from 3 to 4 chars), then the phase right-justified
  // into whatever width remains so the whole line is exactly 16 chars.
  char prefix[24];
  int prefix_len = snprintf(prefix, sizeof(prefix), "%s %s", type, intv);
  if (prefix_len < 0) prefix_len = 0;
  int phase_width = 16 - prefix_len;
  if (phase_width < 0) phase_width = 0;
  char tmp[32];
  snprintf(tmp, sizeof(tmp), "%s%*.*s", prefix, phase_width, phase_width, phase);
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
