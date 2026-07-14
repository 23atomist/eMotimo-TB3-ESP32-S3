
/*
	NOTE: you must: #include "SoftwareSerial.h"
	BEFORE including the class header file

				allen joslin
				payson productions
				allen@joslin.net
*/

#if !defined(ESP32)
#include "SoftwareSerial.h"
#endif
#include "NHDLCD9.h"

/* ======================================================== */

#define PINOUT      0
#define POSBASE     1
#define BOUNCE      2
#define NUMROWS     3
#define NUMCOLS     4
#define LASTROW     5
#define LASTCOL     6
#define LASTBRIGHT  8
#define BOUNCEMicros 9

//--------------------------
#if !defined(ESP32)
NHDLCD9::NHDLCD9 ( int pin, int numRows, int numCols, int posBase )
	: SoftwareSerial(pin,pin) {
#else
NHDLCD9::NHDLCD9 ( int pin, int numRows, int numCols, int posBase ) {
	_serial = &Serial1;
	memset(_shadow, ' ', sizeof(_shadow));
	_shadow[0][16] = 0;
	_shadow[1][16] = 0;
	_srow = 0; _scol = 0; _wstate = 0;
#endif
	_bv[PINOUT]=pin;
	_bv[POSBASE]=posBase;
	_bv[BOUNCE]=1;
	_bv[NUMROWS]=numRows;
	_bv[NUMCOLS]=numCols;
	_bv[LASTROW]=1;
	_bv[LASTCOL]=1;
	_bv[LASTBRIGHT]=8;
	_bv[BOUNCEMicros]=500;
	_ro[0]=0;
	_ro[1]=64;
	_ro[2]=numCols;
	_ro[3]=_ro[1]+numCols;
}

//--------------------------
void NHDLCD9::setup( int startPcnt, boolean startEmpty ) {
#if !defined(ESP32)
	pinMode(_bv[PINOUT], OUTPUT);
	delay(_bv[BOUNCE]);
	begin(9600);
	delay(_bv[BOUNCE]);
#else
	_serial->begin(9600, SERIAL_8N1, -1, _bv[PINOUT]);
	delay(500);
#endif
	if (startEmpty) {
		empty();
	}
	bright(8);
	//cursorOff();
}

//--------------------------

void NHDLCD9::on () {
	//write(0xfe); delay(_bv[BOUNCE]);
	//write(0x41); delay(_bv[BOUNCE]);
	command(0x41);

}

void NHDLCD9::off () {
	//write(0xfe); delay(_bv[BOUNCE]);
	//write(0x42); delay(_bv[BOUNCE]);
    command(0x43);
}

void NHDLCD9::empty () {
	//write(0xfe); delay(_bv[BOUNCE]);
	//write(0x51); delay(_bv[BOUNCE]*10);
	command(0x51); delay(10);

}

void NHDLCD9::cursorOff() {
	//write(0xfe); delay(_bv[BOUNCE]);
	//write(0x4c); delay(_bv[BOUNCE]);
	command(0x4c);

	//write(0xfe); delay(_bv[BOUNCE]);
	//write(0x48); delay(_bv[BOUNCE]);
	command(0x48);
}

void NHDLCD9::cursorBlock () {
	//write(0xfe); delay(_bv[BOUNCE]);
	//write(0x4b); delay(_bv[BOUNCE]);
	command(0x4b);

}

void NHDLCD9::cursorUnderline () {
	//write(0xfe); delay(_bv[BOUNCE]);
	//write(0x47); delay(_bv[BOUNCE]);
	command(0x47);

}

//--------------------------
void NHDLCD9::oldbright ( int pcnt ) {
	if (_bv[LASTBRIGHT] == pcnt) { return; }

	if (pcnt<1){
	  pcnt=1;
	}
	else {
	  pcnt= (((pcnt) * (7)) / (100)) + 1; //basically a map command map(value,0,100,1,8)

	}
//value =  1 byte Set the LCD backlight brightness level, value between 1 to 8
  //write(0xfe); delay(_bv[BOUNCE]);
  //write(0x53); delay(_bv[BOUNCE]);
  command(0x53);
  write((uint8_t) pcnt); delay(_bv[BOUNCE]);

  	_bv[LASTBRIGHT] = pcnt;
}

void NHDLCD9::bright ( int val ) {
	if (_bv[LASTBRIGHT] == val) { return; }
	if (val<1){
		  val=1;
		}
	if (val>8){
		  val=8;
		}
  command(0x53);
  write((uint8_t) val); delay(_bv[BOUNCE]);

  	_bv[LASTBRIGHT] = val;
}




void NHDLCD9::contrast ( int contrastval ) {

  command(0x52);
  write((uint8_t) contrastval); delay(_bv[BOUNCE]);

}




//--------------------------
void NHDLCD9::pos ( int line, int pos )
{
pos--;

if (line == 2) pos += 64;

 command(0x45);
 write((uint8_t)  pos );   delay(_bv[BOUNCE]);
}


#if defined(ESP32)
void NHDLCD9::shadowByte(uint8_t c) {
	switch (_wstate) {
	case 0: // normal stream
		if (c == 0xFE) { _wstate = 1; return; }
		if (c >= 0x20 && c <= 0x7E) {
			if (_srow < 2 && _scol < 16) _shadow[_srow][_scol] = (char)c;
			if (_scol < 16) _scol++;
		}
		return;
	case 1: // command byte after 0xFE
		if (c == 0x45) { _wstate = 2; return; }            // set cursor: position arg follows
		if (c == 0x51) {                                    // clear screen
			memset(_shadow[0], ' ', 16);
			memset(_shadow[1], ' ', 16);
			_srow = 0; _scol = 0; _wstate = 0; return;
		}
		if (c == 0x52 || c == 0x53) { _wstate = 3; return; } // contrast/brightness: 1 arg
		_wstate = 0; return;                                 // on/off/cursor cmds: no args
	case 2: // cursor position argument
		_srow = (c >= 64) ? 1 : 0;
		_scol = (uint8_t)(c % 64);
		if (_scol > 15) _scol = 15;
		_wstate = 0; return;
	case 3: // swallow one argument byte
		_wstate = 0; return;
	}
}

void NHDLCD9::getShadow(char *line1, char *line2) {
	memcpy(line1, _shadow[0], 17);
	memcpy(line2, _shadow[1], 17);
}
#endif

// Functions for sending the special command values
void NHDLCD9::command(uint8_t value){
	write(0xFE);
	write(value);
	//delay(_bv[BOUNCE]);
	delayMicroseconds(_bv[BOUNCEMicros]);    //_bv[BOUNCEMicros]
}



// shortcuts

void NHDLCD9::at ( int row, int col, char v )				{ pos(row,col); print(v); }
void NHDLCD9::at ( int row, int col, const char v[] )	{ pos(row,col); print(v); }
void NHDLCD9::at ( int row, int col, uint8_t v )			{ pos(row,col); print(v); }
void NHDLCD9::at ( int row, int col, int v )				{ pos(row,col); print(v); }
void NHDLCD9::at ( int row, int col, unsigned int v )	{ pos(row,col); print(v); }
void NHDLCD9::at ( int row, int col, long v )				{ pos(row,col); print(v); }
void NHDLCD9::at ( int row, int col, unsigned long v )	{ pos(row,col); print(v); }
void NHDLCD9::at ( int row, int col, long v, int t )		{ pos(row,col); print(v,t); }
void NHDLCD9::at ( int row, int col, String v)		{ pos(row,col); print(v); }


/* ======================================================== */
