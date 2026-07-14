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
