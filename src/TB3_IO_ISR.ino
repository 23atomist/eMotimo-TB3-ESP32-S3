/*

(c) 2015 Brian Burling eMotimo INC


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

void init_external_triggering()
  {
    pinMode(IO_3, INPUT);
    digitalWrite(IO_3, HIGH);
    attachInterrupt(1, cam_change, CHANGE);  
  }
  
  
void cam_change()
{
  changehappened=true;
  state=digitalRead(3);
  if (DEBUG) Serial.print("i");
   
}


#if defined(ESP32)
#include <Arduino.h>

hw_timer_t *motor_timer = NULL;
volatile bool motor_timer_running = false;
extern void onTimer();

void setupstartISR1 ()
{
    // 1 MHz clock frequency (1 tick = 1 microsecond)
    motor_timer = timerBegin(1000000); // timer starts counting immediately
    timerAttachInterrupt(motor_timer, &onTimer);
    // Stop and zero the counter BEFORE arming the alarm. timerBegin() leaves
    // the timer running, so arming a 25us auto-reload alarm first fires the
    // ISR in the window before timerStop() - an intermittent boot crash.
    timerStop(motor_timer);
    timerRestart(motor_timer);
    // Alarm every 25 microseconds (40kHz); timer is stopped, so it stays idle.
    timerAlarm(motor_timer, 25, true, 0);
}

// Idempotent: DFSetup() starts the free-running engine on every jog screen
// entry, and synced moves call start/stop in pairs - double calls would
// otherwise make the gptimer driver log state errors.
void startISR1 ()
{
    if (motor_timer_running) return;
    timerRestart(motor_timer); // count from 0 so the first tick is a full 25us
    timerStart(motor_timer);
    motor_timer_running = true;
}

void stopISR1 ()
{
    if (motor_timer_running) {
        timerStop(motor_timer);
        motor_timer_running = false;
    }
    sync_isr_steps(); // fold ISR integer step counts into float current_steps
}

#else

void setupstartISR1 ()
{
    TCCR1A = 0;
    TCCR1B = _BV(WGM13);
  
    ICR1 = (F_CPU / 4000000) * TIME_CHUNK; // goes twice as often as time chunk, but every other event turns off pins
    TCCR1B &= ~(_BV(CS10) | _BV(CS11) | _BV(CS12));
    TIMSK1 = _BV(TOIE1);
    TCCR1B |= _BV(CS10);

}


void startISR1 ()
{

    TIMSK1 = _BV(TOIE1);

}

void stopISR1 ()
{
    TIMSK1 &= ~_BV(TOIE1);

}
#endif


void Jogloop()
{
  int32_t *ramValues = (int32_t *)malloc(sizeof(int32_t) * MOTOR_COUNT);
  int32_t *ramNotValues = (int32_t *)malloc(sizeof(int32_t) * MOTOR_COUNT);
 
  while (true) //short fast loop pull this out later
  {
    if (!nextMoveLoaded)
      updateMotorVelocities2();
  }
}//end of loop


