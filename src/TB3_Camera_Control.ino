/*

TThis code started with OpenMoco Time Lapse Engine openmoco.org and was modified by Brian Burling
to work with eMotimo product.

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.


*/

/*

  ========================================
  Camera control functions
  ========================================
  
*/

void fire_camera(unsigned long exp_tm) {

   
    // determine if focus pin should be brought high
    // w. the shutter pin (for some nikons, etc.)
    
  digitalWrite(FOCUS_PIN, HIGH);
    
  digitalWrite(CAMERA_PIN, HIGH);
    // start timer to stop camera exposure
  MsTimer2_set(exp_tm);
  MsTimer2_start();

 Shutter_Signal_Engaged=true; //Update Shutter Signal Engaged to ON
 if (DEBUG)  {Serial.print("ShutON ");Serial.print(millis()-interval_tm);Serial.print(";");}
  
  return;
}


void stop_camera() {
  MsTimer3_stop();
  digitalWrite(CAMERA_PIN, LOW);
 
    // we do this every time, because
    // it's possible that the flag
    // that controls whether or not to
    // trip focus w. shutter may have
    // been reset during our exposure,
    // and failing to do so would keep
    // the focus pin high for a long
    // time.
    
  digitalWrite(FOCUS_PIN, LOW);
 
    // turn off timer - we do this
    // after the digitalWrite() to minimize
    // over-shooting in case this takes some
    // unusually-long amount of time
    
  //MsTimer2::stop();

    // are we supposed to delay before allowing
    // the motors to move?  Register a timer
    // to clear out status flags, otherwise
    // just clear them out now.
    
    // the delay is used to prevent motor movement
    // when shot timing is controlled by the camera.
    // the post-delay should be set to an amount greater
    // than the max possible camera exposure timing
    
      // update Shutter Signal Engaged to be off
   Shutter_Signal_Engaged=false;

   if (DEBUG) {Serial.print("ShutOff ");Serial.print(millis()-interval_tm);Serial.print(";");}
 
}//***************************************************************************************//
//Start of MSTimer2 routines - this is 
#if defined(ESP32)
#include <Ticker.h>
Ticker camera_timer;

void MsTimer2_set(unsigned long ms) {
	if (ms == 0)
		MsTimer2_msecs = 1;
	else
		MsTimer2_msecs = ms;
}

void MsTimer2_start() {
	camera_timer.once_ms(MsTimer2_msecs, stop_camera);
}

void MsTimer3_stop() {
	camera_timer.detach();
}

#else

void (*MsTimer2_func)();

void MsTimer2_set(unsigned long ms) {
	float prescaler = 0.0;

	if (ms == 0)
		MsTimer2_msecs = 1;
	else
		MsTimer2_msecs = ms;

	//func = f;

	TIMSK2 &= ~(1<<TOIE2);
	TCCR2A &= ~((1<<WGM21) | (1<<WGM20));
	TCCR2B &= ~(1<<WGM22);
	ASSR &= ~(1<<AS2);
	TIMSK2 &= ~(1<<OCIE2A);

        TCCR2B |= (1<<CS22);
        TCCR2B &= ~((1<<CS21) | (1<<CS20));
        prescaler = 64.0;

	MsTimer2_tcnt2 = 256 - (int)((float)F_CPU * 0.001 / prescaler);
}







void MsTimer2_start() {
	MsTimer2_count = 0;
	MsTimer2_overflowing = 0;
	TCNT2 = MsTimer2_tcnt2;
	TIMSK2 |= (1<<TOIE2);
}

void MsTimer3_stop() {
	TIMSK2 &= ~(1<<TOIE2);

}

void MsTimer2_overflow() {
	MsTimer2_count += 1;

	if (MsTimer2_count >= MsTimer2_msecs && !MsTimer2_overflowing) {
		MsTimer2_overflowing = 1;
		MsTimer2_count = MsTimer2_count - MsTimer2_msecs; // subtract ms to catch missed overflows
					// set to 0 if you don't want this.
		stop_camera();
		MsTimer2_overflowing = 0;
	}
}


ISR(TIMER2_OVF_vect) {

	TCNT2 = MsTimer2_tcnt2;
	MsTimer2_overflow();
}
#endif


