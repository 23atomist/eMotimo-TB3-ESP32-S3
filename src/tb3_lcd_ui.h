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
