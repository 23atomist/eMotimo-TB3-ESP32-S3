
/*
	NOTE: you must: #include <SoftwareSerial.h>
	BEFORE including the class header file

				allen joslin
				payson productions
				allen@joslin.net
*/

#ifndef NHDLCD9_h
#define NHDLCD9_h

#include "Arduino.h"
#if !defined(ESP32)
#include <SoftwareSerial.h>
#endif

class NHDLCD9 :
#if !defined(ESP32)
  public SoftwareSerial
#else
  public Print
#endif
{
private:
	int _bv[10];
	int _ro[5];
	void command(uint8_t);
#if defined(ESP32)
	HardwareSerial *_serial;
	// Shadow copy of the 2x16 panel for the web UI. write() sees every byte
	// sent to the panel, including 0xFE command sequences, so a tiny state
	// machine filters commands and tracks the cursor.
	char _shadow[2][17];
	uint8_t _srow, _scol;
	uint8_t _wstate;   // 0 normal, 1 got 0xFE, 2 expect position, 3 expect arg
	void shadowByte(uint8_t c);
#endif

public:
	NHDLCD9 ( int pin, int numRows, int numCols, int posBase=1 );
   void setup ( int brightPcnt=100, boolean startEmpty=true );

   void on ();
   void off ();

   void empty ();

   //void scrollLeft ();
   //void scrollRight ();

   void bright ( int pcnt );
   void oldbright ( int pcnt );
   void contrast ( int contrastval );
   void pos ( int row, int col );

   void cursorUnderline();
   void cursorBlock();
   void cursorOff ();

	// shortcuts for printing at particular positions
   void at ( int row, int col, char );
   void at ( int row, int col, const char[] );
   void at ( int row, int col, uint8_t );
   void at ( int row, int col, int );
   void at ( int row, int col, unsigned int );
   void at ( int row, int col, long );
   void at ( int row, int col, unsigned long );
   void at ( int row, int col, long, int );
   void at ( int row, int col, String );

#if defined(ESP32)
   virtual size_t write(uint8_t c) {
       shadowByte(c);
       return _serial->write(c);
   }
   virtual size_t write(const uint8_t *buffer, size_t size) {
       for (size_t i = 0; i < size; i++) shadowByte(buffer[i]);
       return _serial->write(buffer, size);
   }
   // copy shadow lines into caller buffers (at least 17 bytes each)
   void getShadow(char *line1, char *line2);
#endif
};


#endif
