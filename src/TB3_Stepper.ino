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

//BEGIN STEPPER SECTION


#if defined(ESP32)
// Direct register writes: ISR-safe (no flash-resident framework code, no
// error-log path) and fast enough for the 40kHz stepper ISR.
#define PIN_ON(port, pin)  { fast_gpio_write(pin, true); }
#define PIN_OFF(port, pin) { fast_gpio_write(pin, false); }
#else
#define PIN_ON(port, pin)  { port |= pin; }
#define PIN_OFF(port, pin) { port &= ~pin; }
#endif


#if defined(ESP32)
    #define MOTOR0_STEP_PORT 0
    #define MOTOR0_STEP_PIN  5
      
    #define MOTOR1_STEP_PORT 0
    #define MOTOR1_STEP_PIN  6
      
    #define MOTOR2_STEP_PORT 0
    #define MOTOR2_STEP_PIN  7
#elif defined(__AVR_ATmega1280__) || defined(__AVR_ATmega2560__) //Mega

    #define MOTOR0_STEP_PORT PORTE
    #define MOTOR0_STEP_PIN  B00001000 //Pin 5  PE3
      
    #define MOTOR1_STEP_PORT PORTH
    #define MOTOR1_STEP_PIN  B00001000 //Pin 6  PH3
      
    #define MOTOR2_STEP_PORT PORTH
    #define MOTOR2_STEP_PIN  B00010000 //Pin 7  PH4
    
#else
    #define MOTOR0_STEP_PORT PORTD
    #define MOTOR0_STEP_PIN  B00100000 //Pin 5
      
    #define MOTOR1_STEP_PORT PORTD
    #define MOTOR1_STEP_PIN  B01000000 //Pin 6
      
    #define MOTOR2_STEP_PORT PORTD
    #define MOTOR2_STEP_PIN  B10000000 //Pin 7
    
#endif




//init our variables
long max_delta;
long x_counter;
long y_counter;
long z_counter;
bool x_can_step;
bool y_can_step;
bool z_can_step;
int milli_delay;

void init_steppers()
{
#if defined(ESP32)
	// The DFMoco ISR writes motors[i].dirPin; without this init those are 0
	// (GPIO0) until DFSetup() runs, and unconfigured pins crash the ISR via
	// the core's error-log path. Assign the real pins up front.
	motors[0].stepPin = MOTOR0_STEP;
	motors[0].dirPin  = MOTOR0_DIR;
	motors[1].stepPin = MOTOR1_STEP;
	motors[1].dirPin  = MOTOR1_DIR;
	motors[2].stepPin = MOTOR2_STEP;
	motors[2].dirPin  = MOTOR2_DIR;
#endif
	//turn them off to start.
	disable_PT();  //  low, standard, high, we power down at the end of program
        disable_AUX();  // low, standard, high, we power down at the end of program
	calculate_deltas();
}

void dda_move(long micro_delay)
{
	//enable our steppers
        if (AUX_ON) enable_AUX();
        enable_PT();

	
	//figure out our deltas
	max_delta = max((long)delta_steps.x, (long)delta_steps.y);
	max_delta = max((long)delta_steps.z, max_delta);

	//init stuff.
	long x_counter = -max_delta/2;
	long y_counter = -max_delta/2;
	long z_counter = -max_delta/2;
	
	//our step flags
	bool x_can_step = 0;
	bool y_can_step = 0;
	bool z_can_step = 0;
	
	if (micro_delay >= 16383)
		milli_delay = micro_delay / 1000;
	else
		milli_delay = 0;

	//do our DDA line!
	do
	{
		x_can_step = can_step(current_steps.x, target_steps.x);
		y_can_step = can_step(current_steps.y, target_steps.y);
		z_can_step = can_step(current_steps.z, target_steps.z);

		if (x_can_step)
		{
			x_counter += delta_steps.x;
			
			if (x_counter > 0)
			{
				//do_step(MOTOR0_STEP);
                                PIN_ON(MOTOR0_STEP_PORT, MOTOR0_STEP_PIN);
				x_counter -= max_delta;
				
				if (x_direction){
					current_steps.x++;
                                }
				else {
					current_steps.x--;

                                }
			}
		}

		if (y_can_step)
		{
			y_counter += delta_steps.y;
			
			if (y_counter > 0)
			{
				//do_step(MOTOR1_STEP);
                                PIN_ON(MOTOR1_STEP_PORT, MOTOR1_STEP_PIN);
				y_counter -= max_delta;

				if (y_direction){
					current_steps.y++;
                                }
				else {
					current_steps.y--;
                                }
			}
		}
		
		if (z_can_step)
		{
			z_counter += delta_steps.z;
			
			if (z_counter > 0)
			{
				//do_step(MOTOR2_STEP);
                                PIN_ON(MOTOR2_STEP_PORT, MOTOR2_STEP_PIN);
				z_counter -= max_delta;
				
				if (z_direction){
					current_steps.z++;
                                }
				else {
					current_steps.z--;
                                }
			}
		}

		    PIN_OFF(MOTOR0_STEP_PORT, MOTOR0_STEP_PIN);
                    PIN_OFF(MOTOR1_STEP_PORT, MOTOR1_STEP_PIN);
                    PIN_OFF(MOTOR2_STEP_PORT, MOTOR2_STEP_PIN);		
		//wait for next step.
		if (milli_delay > 0)
			delay(milli_delay);			
		else
			delayMicroseconds(micro_delay);
	}
	while (x_can_step || y_can_step || z_can_step);
	
	//set our points to be the same
	current_steps.x = target_steps.x;
	current_steps.y = target_steps.y;
	current_steps.z = target_steps.z;
	calculate_deltas();
}

bool can_step(long current, long target)
{
	//stop us if we're on target
	if (target == current)
		return false;
	
	//default to being able to step
	return true;
}


void set_target(float x, float y, float z)
{
	target_steps.x = x;
	target_steps.y = y;
	target_steps.z = z;

        motors[0].destination = long(target_steps.x);
        motors[1].destination = long(target_steps.y);
        motors[2].destination = long(target_steps.z);
	
	calculate_deltas();
}

void set_position(float x, float y, float z)
{
	current_steps.x = x;
	current_steps.y = y;
	current_steps.z = z;

        motors[0].position = long(current_steps.x);
        motors[1].position = long(current_steps.y);
        motors[2].position = long(current_steps.z);

	
	calculate_deltas();
}

void calculate_deltas()
{

	delta_steps.x = abs(target_steps.x - current_steps.x);
	delta_steps.y = abs(target_steps.y - current_steps.y);
	delta_steps.z = abs((long)target_steps.z - (long)current_steps.z);
	
	//what is our direction
	x_direction = (target_steps.x >= current_steps.x);
	y_direction = (target_steps.y >= current_steps.y);
	z_direction = (target_steps.z >= current_steps.z);

	//set our direction pins as well
	digitalWrite(MOTOR0_DIR, x_direction);
	digitalWrite(MOTOR1_DIR, y_direction);
	digitalWrite(MOTOR2_DIR, z_direction);
}


long calculate_feedrate_delay_1()  
{
     
    long master_steps = 0;
	
	//find the dominant axis.
	if (delta_steps.x > delta_steps.y)
	{
		if (delta_steps.z > delta_steps.x)
			master_steps = delta_steps.z;
		else
			master_steps = delta_steps.x;
	}
	else
	{
		if (delta_steps.z > delta_steps.y)
			master_steps = delta_steps.z;
		else
			master_steps = delta_steps.y;
	}
        if (DEBUG_MOTOR) {Serial.print("master_steps= "); Serial.print(master_steps);Serial.print(";");}
        if (intval==VIDEO_INTVAL) { 
           //return ((interval*(1000L))/master_steps); //   Use the full time for video - hardcoded to 1000 *50 mc or 50000us or 0.050 seconds
           if (DEBUG_MOTOR) {Serial.print("feedratedelay_1_vid= "); Serial.print((interval*(1000L))/master_steps);Serial.print(";");} 
           return ((interval*(1000L))/master_steps); //  This is the issue - intervla
            
        }
        else if (intval==EXTTRIG_INTVAL) {
          if (DEBUG_MOTOR) {Serial.print("feedratedelay_1_StopMo= "); Serial.print((((intval-static_tm)*100000)/master_steps)*0.5);Serial.print(";");}   
          return ((((10L)*100000L)/master_steps)*0.5); //  Use half available time to move for stills
           
        }
        
        else {
          if (DEBUG_MOTOR) {Serial.print("feedratedelay_1_SMS="); Serial.print((((intval-static_tm-prefire_time)*100000L)/master_steps)*0.5);Serial.print(";");}   
          return (abs((((intval-static_tm-prefire_time)*100000L)/master_steps)*0.5)); //  Use half available time to move for stills
           
        }
}

long calculate_feedrate_delay_video()  
{
     
    long master_steps = 0;
    long current_feedrate=0;
	
	//find the dominant axis.
	if (delta_steps.z > delta_steps.x)
	{
		if (delta_steps.y > delta_steps.z)
			master_steps = delta_steps.y;
		else
			master_steps = delta_steps.z;
	}
	else
	{
		if (delta_steps.y > delta_steps.x)
			master_steps = delta_steps.y;
		else
			master_steps = delta_steps.x;
	}
        if (DEBUG_MOTOR) {Serial.print("master_steps= "); Serial.print(master_steps);Serial.print(";");}

           //return ((interval*(1000L))/master_steps); //   
          
  if (program_progress_2PT==3) {
      current_feedrate=((interval*(VIDEO_FEEDRATE_NUMERATOR)*long(keyframe[0][3]-keyframe[0][2]))/master_steps); //  total move for all linear
  }    
  else {    //20 hz program
      current_feedrate=((interval*(VIDEO_FEEDRATE_NUMERATOR))/master_steps); //  Use the full time for video - hardcoded to 1000 *50 mc or 50000us or 0.050 seconds or 20hz
  } 
  
  if (DEBUG_MOTOR) {Serial.print("feedratedelay_1_vid= "); Serial.print(current_feedrate);Serial.print(";");}
  return (current_feedrate);
}




long calculate_feedrate_delay_2() //used for real time moves
{
       long master_steps = 0;
	
     //find the dominant axis.
	if (delta_steps.x > delta_steps.y)
	{
		if (delta_steps.z > delta_steps.x)
			master_steps = delta_steps.z;
		else
			master_steps = delta_steps.x;
	}
	else
	{
		if (delta_steps.z > delta_steps.y)
			master_steps = delta_steps.z;
		else
			master_steps = delta_steps.y;
	}
//Serial.print("master_steps="); Serial.println(master_steps);
long fr=10000L/master_steps;
//Serial.print("fr="); Serial.println(fr);
return (fr); // read about every 42 ms (24 times a second)
	
}




void disable_PT()
{
	digitalWrite(MOTOR_EN, HIGH);
}


void disable_AUX()
{
	digitalWrite(MOTOR_EN2, HIGH);
}


void enable_PT()
{
	digitalWrite(MOTOR_EN, LOW);
}

void enable_AUX()
{
	digitalWrite(MOTOR_EN2, LOW);
}










