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


#if defined(ESP32)
#if defined(USE_USB_HOST) && (USE_USB_HOST == 1)
#include "EspUsbHost.h"

extern EspUsbHost usbHost;
extern volatile uint8_t g_usb_joy_x;
extern volatile uint8_t g_usb_joy_y;
extern volatile uint16_t g_usb_accel_x;
extern volatile bool g_usb_button_c;
extern volatile bool g_usb_button_z;

// Register USB host callbacks
void myGamepadCallback(const EspUsbHostGamepadEvent &event) {
    if (event.reportLength >= 2) {
        g_usb_joy_x = event.reportData[0];
        g_usb_joy_y = event.reportData[1];
    }
    if (event.reportLength >= 3) {
        g_usb_accel_x = ((uint16_t)event.reportData[2]) * 4; // scale 0-255 to 0-1020
    }
    if (event.reportLength >= 5) {
        g_usb_button_c = (event.reportData[4] & 0x01) != 0;
        g_usb_button_z = (event.reportData[4] & 0x02) != 0;
    }
}

void init_usb_joystick() {
    usbHost.onGamepad(myGamepadCallback);
}
#else
void init_usb_joystick() {}
#endif

void calibrate_joystick(int tempx, int tempy)
{
    joy_x_axis_Offset=tempx;  joy_x_axis_Threshold=100;
    joy_y_axis_Offset=tempy;  joy_y_axis_Threshold=100;
    accel_x_axis_Offset=512;  accel_x_axis_Threshold=200;
}

void NunChuckQuerywithEC()
{
#if defined(ESP32)
    // Decay momentary button presses and center joystick from the previous iteration
    g_usb_button_z = false;
    g_usb_button_c = false;
    g_usb_joy_x = joy_x_axis_Offset;
    g_usb_joy_y = joy_y_axis_Offset;

    // Read from serial to simulate gamepad controls
    if (Serial.available() > 0) {
        char ch = Serial.read();
        switch (ch) {
            case 'a': case 'A':
                g_usb_joy_x = joy_x_axis_Offset - 50; // Left
                Serial.println("[Terminal] Joystick Left (A)");
                break;
            case 'd': case 'D':
                g_usb_joy_x = joy_x_axis_Offset + 50; // Right
                Serial.println("[Terminal] Joystick Right (D)");
                break;
            case 'w': case 'W':
                g_usb_joy_y = joy_y_axis_Offset + 50; // Up
                Serial.println("[Terminal] Joystick Up (W)");
                break;
            case 's': case 'S':
                g_usb_joy_y = joy_y_axis_Offset - 50; // Down
                Serial.println("[Terminal] Joystick Down (S)");
                break;
            case 'z': case 'Z':
                g_usb_button_z = true;
                Serial.println("[Terminal] Button Z (Select) Pressed");
                break;
            case 'c': case 'C':
                g_usb_button_c = true;
                Serial.println("[Terminal] Button C (Cancel) Pressed");
                break;
            case ' ': // Space bar centers/resets everything
                Serial.println("[Terminal] Joystick Centered / Buttons Released");
                break;
            case 'p': case 'P': { // print motion-engine state (debug)
                extern volatile bool motor_timer_running;
                Serial.print("[Debug] pos=");
                Serial.print(current_steps.x); Serial.print(",");
                Serial.print(current_steps.y); Serial.print(",");
                Serial.print(current_steps.z);
                Serial.print(" moving="); Serial.print(motorMoving);
                Serial.print(" nextMoveLoaded="); Serial.print(nextMoveLoaded);
                Serial.print(" isr="); Serial.print(motor_timer_running);
                Serial.print(" progstep="); Serial.println(progstep);
                break;
            }
        }
    }

    // Inject Bluetooth gamepad and web UI input. Both write the same
    // virtual joystick variables the rest of the firmware reads, so they
    // work inside every blocking menu loop that polls input.
    tb3_gamepad_poll();
    tb3_web_poll();
#endif
}

void NunChuckjoybuttons()
{
    joy_x_axis = constrain((g_usb_joy_x - joy_x_axis_Offset), -joy_x_axis_Threshold, joy_x_axis_Threshold);
    joy_y_axis = constrain((g_usb_joy_y - joy_y_axis_Offset), -joy_y_axis_Threshold, joy_y_axis_Threshold);
    accel_x_axis = constrain((g_usb_accel_x - accel_x_axis_Offset), -accel_x_axis_Threshold, accel_x_axis_Threshold);
    if(AUX_REV) accel_x_axis *= -1;

    // Create deadband
    int deadband = 15;
    if (joy_x_axis > deadband) {
        joy_x_axis = (joy_x_axis - deadband);
    } else if (joy_x_axis < -deadband) {
        joy_x_axis = (joy_x_axis + deadband);
    } else {
        joy_x_axis = 0;
    }

    if (joy_y_axis > deadband) {
        joy_y_axis = -1 * (joy_y_axis - deadband);
    } else if (joy_y_axis < -deadband) {
        joy_y_axis = -1 * (joy_y_axis + deadband);
    } else {
        joy_y_axis = 0;
    }

    int deadband2 = 100;
    if (accel_x_axis > deadband2) {
        accel_x_axis = -1 * (accel_x_axis - deadband2);
    } else if (accel_x_axis < -deadband2) {
        accel_x_axis = -1 * (accel_x_axis + deadband2);
    } else {
        accel_x_axis = 0;
    }

    // Joystick lock counts
    if (abs(joy_y_axis) > 83) {
        joy_y_lock_count++;
        if (joy_y_lock_count > 250) joy_y_lock_count = 250;
    } else {
        joy_y_lock_count = 0;
    }

    if (abs(joy_x_axis) > 83) {
        joy_x_lock_count++;
        if (joy_x_lock_count > 250) joy_x_lock_count = 250;
    } else {
        joy_x_lock_count = 0;
    }

    c_button = g_usb_button_c ? 1 : 0;
    z_button = g_usb_button_z ? 1 : 0;

    if (!c_button && !z_button) CZ_Released = true;
    if (!c_button) C_Released = true;
    if (!z_button) Z_Released = true;
}

void axis_button_deadzone() {
    joy_x_axis=constrain((g_usb_joy_x-joy_x_axis_Offset),-100,100);
    joy_y_axis=constrain((g_usb_joy_y-joy_y_axis_Offset),-100,100);
    accel_x_axis=constrain((g_usb_accel_x-accel_x_axis_Offset),-130,130);
    if(AUX_REV) accel_x_axis*=-1;
    c_button=g_usb_button_c ? 1 : 0;
    z_button=g_usb_button_z ? 1 : 0;

    if (abs(joy_x_axis)<6.0) joy_x_axis=0.0;
    if(joy_x_axis>5.0) joy_x_axis-=5.0;
    else if(joy_x_axis<-5.0) joy_x_axis+=5.0;

    if (abs(joy_y_axis)<6.0) joy_y_axis=0.0;
    if(joy_y_axis>5.0) joy_y_axis-=5.0;
    else if(joy_y_axis<-5.0) joy_y_axis+=5.0;

    if (abs(accel_x_axis)<31.0) accel_x_axis=0.0;
    if(accel_x_axis>30.0) accel_x_axis-=30.0;
    else if(accel_x_axis<-30.0) accel_x_axis+=30.0;
}

#else

void calibrate_joystick(int tempx, int tempy)
{
if(DEBUG_NC) Serial.println(micros());

    joy_x_axis_Offset=tempx;  joy_x_axis_Threshold=100; //int joy_x_axis_map=180;
    joy_y_axis_Offset=tempy;  joy_y_axis_Threshold=100; //int joy_y_axis_map=180;
    accel_x_axis_Offset=500;  accel_x_axis_Threshold=200; //hardcode this, don't calibrate

    
}

void NunChuckQuerywithEC() //error correction and reinit on disconnect  - takes about 1050 microsecond
{
    if(DEBUG_NC) Serial.println(micros());

  do 
    {  
      Nunchuck.getData();
        
        if (Nunchuck.joyx()==0 && Nunchuck.joyy()==0 ) {  //error condition //throw this out and read again
          delay(1);
          NCReadStatus ++;
          //Serial.println(micros());
        }
         else if (Nunchuck.joyx()==255 && Nunchuck.joyy()==255 && Nunchuck.accelx()==1023) {//nunchuck disconnected, then reconnected  - needs initializing
             Nunchuck.init(0);
             NCReadStatus ++;
             //Serial.println(micros());

         }
         else if (Nunchuck.accelx()==0 && Nunchuck.accely()==0 && Nunchuck.accelz()==0) {//nunchuck just reintialized - needs a few more reads before good
             delay(1);
             NCReadStatus ++;
             //Serial.println(micros());

         }
         else NCReadStatus=0;
         
    }  while (NCReadStatus>0); 
    if(DEBUG_NC) Serial.println(micros()); 
    if(DEBUG_NC) Nunchuck.printData();
 
}



void NunChuckjoybuttons()
{


joy_x_axis=constrain((Nunchuck.joyx()-joy_x_axis_Offset),-joy_x_axis_Threshold,joy_x_axis_Threshold);
joy_y_axis=constrain((Nunchuck.joyy()-joy_y_axis_Offset),-joy_y_axis_Threshold,joy_y_axis_Threshold);
accel_x_axis=constrain((Nunchuck.accelx()-accel_x_axis_Offset),-accel_x_axis_Threshold,accel_x_axis_Threshold);
if(AUX_REV) accel_x_axis*=-1;

//create a deadband
int deadband = 15; // results in 100-15 or +-85 - this is for the joystick
if (joy_x_axis > deadband)  {
  joy_x_axis=(joy_x_axis-deadband); //this direction lines up with the left right of the display
}
else if (joy_x_axis < -deadband) {
  joy_x_axis=(joy_x_axis+deadband);
}
else {
  joy_x_axis = 0;
}
if (joy_y_axis > deadband)  {
  joy_y_axis=-1*(joy_y_axis-deadband);
}
else if (joy_y_axis < -deadband) {
  joy_y_axis=-1*(joy_y_axis+deadband);
}
else {
  joy_y_axis = 0;
}

int deadband2 = 100; //  this is for the accelerometer
if (accel_x_axis > deadband2)  {
  accel_x_axis=-1*(accel_x_axis-deadband2);
}
else if (accel_x_axis < -deadband2) {
  accel_x_axis=-1*(accel_x_axis+deadband2);
}
else {
  accel_x_axis = 0;
}


//check for joystick y lock for more than one second
if (abs(joy_y_axis)>83) {
  joy_y_lock_count++;
  if (joy_y_lock_count > 250) joy_y_lock_count=250; //prevent overflow
}
else {
joy_y_lock_count=0;
}

//check for joystick x lock for more than one second
if (abs(joy_x_axis)>83) {
  joy_x_lock_count++;
  if (joy_x_lock_count > 250) joy_x_lock_count=250; //prevent overflow
}
else {
joy_x_lock_count=0;
}

c_button=Nunchuck.cbutton();
z_button=Nunchuck.zbutton();

if (!c_button && !z_button) CZ_Released=true ; //look for both release of a button to set this flag.
if (!c_button) C_Released=true ; //look for both release of a button to set this flag.
if (!z_button) Z_Released=true ; //look for both release of a button to set this flag.



//if (c_button==1 || z_button==1) user_input();

}


void axis_button_deadzone() {
       
       joy_x_axis=constrain((Nunchuck.joyx()-joy_x_axis_Offset),-100,100); //gets us to +- 100
       joy_y_axis=constrain((Nunchuck.joyy()-joy_y_axis_Offset),-100,100); //gets us to +- 100
       accel_x_axis=constrain((Nunchuck.accelx()-accel_x_axis_Offset),-130,130); //gets us to +- 100
	   if(AUX_REV) accel_x_axis*=-1;
       c_button=Nunchuck.cbutton();
       z_button=Nunchuck.zbutton();

       
       if (abs(joy_x_axis)<6.0) joy_x_axis=0.0;
       if(joy_x_axis>5.0) joy_x_axis-=5.0;
       else if(joy_x_axis<-5.0) joy_x_axis+=5.0;
       
       
       if (abs(joy_y_axis)<6.0) joy_y_axis=0.0;
       if(joy_y_axis>5.0) joy_y_axis-=5.0;
       else if(joy_y_axis<-5.0) joy_y_axis+=5.0;
       
       
       if (abs(accel_x_axis)<31.0) accel_x_axis=0.0;
       if(accel_x_axis>30.0) accel_x_axis-=30.0;
       else if(accel_x_axis<-30.0) accel_x_axis+=30.0;

}
#endif

void applyjoymovebuffer_exponential()  //exponential stuff
{
//scale based on read frequency  base is 500 reads per second  - now 20 reads per second = 25x
joy_x_axis=(joy_x_axis*joy_x_axis*joy_x_axis)/1200L;
joy_y_axis=(joy_y_axis*joy_y_axis*joy_y_axis)/1200L;
accel_x_axis=(accel_x_axis*accel_x_axis*accel_x_axis)/300L;
//joy_x_axis=(joy_x_axis*joy_x_axis)/4;
//joy_y_axis*=25;
//accel_x_axis*=25;

//control max speeds of the axis
//joy_y_axis=map(joy_y_axis,-90,90,-35,35); //reduc 

 //slow down changes to avoid sudden stops and starts
int ss_buffer=100;
int buffer_x;
int buffer_y;
int buffer_z;


//if ((joy_x_axis-prev_joy_x_reading)>ss_buffer) joy_x_axis=(prev_joy_x_reading+ss_buffer);
//else if ((joy_x_axis-prev_joy_x_reading)<-ss_buffer) joy_x_axis=(prev_joy_x_reading-ss_buffer);

buffer_x=(joy_x_axis-prev_joy_x_reading)/5;
joy_x_axis=prev_joy_x_reading+buffer_x;
if (abs(joy_x_axis)<5) joy_x_axis=0;

//if ((joy_y_axis-prev_joy_y_reading)>ss_buffer) joy_y_axis=(prev_joy_y_reading+ss_buffer);
//else if ((joy_y_axis-prev_joy_y_reading)<-ss_buffer) joy_y_axis=(prev_joy_y_reading-ss_buffer);

buffer_y=(joy_y_axis-prev_joy_y_reading)/5;
joy_y_axis=prev_joy_y_reading+buffer_y;
if (abs(joy_y_axis)<5) joy_y_axis=0;

//if ((accel_x_axis-prev_accel_x_reading)>ss_buffer) accel_x_axis=(prev_accel_x_reading+ss_buffer);
//else if ((accel_x_axis-prev_accel_x_reading)<-ss_buffer) accel_x_axis=(prev_accel_x_reading-ss_buffer);

buffer_z=(accel_x_axis-prev_accel_x_reading)/2;
accel_x_axis=prev_accel_x_reading+buffer_z;
if (abs(accel_x_axis)<5) accel_x_axis=0;

//Serial.print(joy_x_axis);Serial.print(" ___ ");Serial.println(joy_y_axis);


prev_joy_x_reading=joy_x_axis;
prev_joy_y_reading=joy_y_axis;
prev_accel_x_reading=accel_x_axis;

//FloatPoint fp;
//fp.x = 0.0;
//fp.y = 0.0;
//fp.z = 0.0;

fp.x = joy_x_axis + current_steps.x;
fp.y = joy_y_axis + current_steps.y;
if (AUX_ON) fp.z = accel_x_axis + current_steps.z;

set_target(fp.x,fp.y,fp.z);
feedrate_micros=calculate_feedrate_delay_2();
}



void applyjoymovebuffer_linear()
{

//control max speeds of the axis
joy_y_axis=map(joy_y_axis,-90,90,-35,35); //

 //slow down changes to avoid sudden stops and starts

int ss_buffer=1;


if ((joy_x_axis-prev_joy_x_reading)>ss_buffer) joy_x_axis=(prev_joy_x_reading+ss_buffer);
else if ((joy_x_axis-prev_joy_x_reading)<-ss_buffer) joy_x_axis=(prev_joy_x_reading-ss_buffer);

if ((joy_y_axis-prev_joy_y_reading)>ss_buffer) joy_y_axis=(prev_joy_y_reading+ss_buffer);
else if ((joy_y_axis-prev_joy_y_reading)<-ss_buffer) joy_y_axis=(prev_joy_y_reading-ss_buffer);

if ((accel_x_axis-prev_accel_x_reading)>ss_buffer) accel_x_axis=(prev_accel_x_reading+ss_buffer);
else if ((accel_x_axis-prev_accel_x_reading)<-ss_buffer) accel_x_axis=(prev_accel_x_reading-ss_buffer);

//Serial.print(joy_x_axis);Serial.print(" ___ ");Serial.println(joy_y_axis);


prev_joy_x_reading=joy_x_axis;
prev_joy_y_reading=joy_y_axis;
prev_accel_x_reading=accel_x_axis;

FloatPoint fp;
fp.x = 0.0;
fp.y = 0.0;

fp.x = joy_x_axis + current_steps.x;
fp.y = joy_y_axis + current_steps.y;
fp.z = accel_x_axis + current_steps.z;

set_target(fp.x,fp.y,fp.z);
feedrate_micros=calculate_feedrate_delay_2();

}


void nc_sleep()  
{
        if ((joy_x_axis > 15) | (joy_x_axis < -15) | (joy_y_axis > 15) | (joy_y_axis < -15)) {
           digitalWrite(MOTOR_EN, LOW);
            }
        else  digitalWrite(MOTOR_EN, HIGH);
        
}

#if !defined(ESP32)
void axis_button_deadzone() {
       
       joy_x_axis=constrain((Nunchuck.joyx()-joy_x_axis_Offset),-100,100); //gets us to +- 100
       joy_y_axis=constrain((Nunchuck.joyy()-joy_y_axis_Offset),-100,100); //gets us to +- 100
       accel_x_axis=constrain((Nunchuck.accelx()-accel_x_axis_Offset),-130,130); //gets us to +- 100
	   if(AUX_REV) accel_x_axis*=-1;
       c_button=Nunchuck.cbutton();
       z_button=Nunchuck.zbutton();

       
       if (abs(joy_x_axis)<6.0) joy_x_axis=0.0;
       if(joy_x_axis>5.0) joy_x_axis-=5.0;
       else if(joy_x_axis<-5.0) joy_x_axis+=5.0;
       
       
       if (abs(joy_y_axis)<6.0) joy_y_axis=0.0;
       if(joy_y_axis>5.0) joy_y_axis-=5.0;
       else if(joy_y_axis<-5.0) joy_y_axis+=5.0;
       
       
       if (abs(accel_x_axis)<31.0) accel_x_axis=0.0;
       if(accel_x_axis>30.0) accel_x_axis-=30.0;
       else if(accel_x_axis<-30.0) accel_x_axis+=30.0;

}
#endif


void updateMotorVelocities2()   //Happens  20 times a second
{
#if defined(ESP32)
        sync_isr_steps(); // keep float current_steps fresh while the ISR runs
#endif

        //limit speeds
        float motormax0=PAN_MAX_JOG_STEPS_PER_SEC/20000.0;
        float motormax1=TILT_MAX_JOG_STEPS_PER_SEC/20000.0;
        float motormax2=AUX_MAX_JOG_STEPS_PER_SEC/20000.0;
		if (motormax2>0.75) motormax2=.75; //limits max speed during joy to reduce vibration
		
        

        //accelerations - accumulator limit is is 65553. Loop is 20Hz.   If we want zero to max to be 1 sec, we choose 
        //example 1 If we want zero to max to be 1 sec, we choose (65535/20)/1.0 =3276.75 this is the max per cycle.
        //example 2 If we want zero to max to be 2 sec,(65535/20)/2.0 =1638.375 this is the max per cycle.
     
        float accelmax0=(65535.0/20.0)/1.0;
        float accelmax1=(65535.0/20.0)/1.0;
        float accelmax2=(65535.0/20.0)/1.0;
        //could also make accel dynamic based on velocity - decelerate faster when going fast - have to make sure we don't create hyperbole
        

        //exponential curve
        joy_x_axis=float(joy_x_axis*joy_x_axis*joy_x_axis)/10000.0;
        joy_y_axis=float(joy_y_axis*joy_y_axis*joy_y_axis)/10000.0;
        accel_x_axis=float(accel_x_axis*accel_x_axis*accel_x_axis)/10000.0;
        
        //record last speed for compare, multiply by direction to get signed value
        float signedlastMotorMoveSpeed0 = motors[0].nextMotorMoveSpeed;
        if (!motors[0].dir) signedlastMotorMoveSpeed0*=-1.0; //0 is reverse
        float signedlastMotorMoveSpeed1 = motors[1].nextMotorMoveSpeed;
        if (!motors[1].dir) signedlastMotorMoveSpeed1*=-1.0;
        float signedlastMotorMoveSpeed2 = motors[2].nextMotorMoveSpeed; 
        if (!motors[2].dir) signedlastMotorMoveSpeed2*=-1.0;
        
        //set the accumulator value for the 1/20th second move - this is our accumulator value
        float signedMotorMoveSpeedTarget0= joy_x_axis * 655.3*motormax0;
        float signedMotorMoveSpeedTarget1= joy_y_axis * 655.3*motormax1;
        float signedMotorMoveSpeedTarget2= accel_x_axis * 655.3*motormax2;

        

        //pan accel
        if (signedMotorMoveSpeedTarget0!=signedlastMotorMoveSpeed0)
        {
            if ((signedMotorMoveSpeedTarget0>signedlastMotorMoveSpeed0)&& ((signedMotorMoveSpeedTarget0-signedlastMotorMoveSpeed0)>accelmax0))//accel
            {
                signedMotorMoveSpeedTarget0=signedlastMotorMoveSpeed0+ accelmax0;
            }
           
           else if ((signedMotorMoveSpeedTarget0<signedlastMotorMoveSpeed0)&& ((signedlastMotorMoveSpeed0-signedMotorMoveSpeedTarget0)>accelmax0) ) //decel
           {
                signedMotorMoveSpeedTarget0= signedlastMotorMoveSpeed0 -accelmax0;
           }
        }
        //tilt accel
        if (signedMotorMoveSpeedTarget1!=signedlastMotorMoveSpeed1)
        {
            if ((signedMotorMoveSpeedTarget1>signedlastMotorMoveSpeed1)&& ((signedMotorMoveSpeedTarget1-signedlastMotorMoveSpeed1)>accelmax1))//accel
            {
                signedMotorMoveSpeedTarget1=signedlastMotorMoveSpeed1+accelmax1;
            }
           
           else if ((signedMotorMoveSpeedTarget1<signedlastMotorMoveSpeed1)&& ((signedlastMotorMoveSpeed1-signedMotorMoveSpeedTarget1)>accelmax1) ) //decel
           {
                signedMotorMoveSpeedTarget1= signedlastMotorMoveSpeed1 -accelmax1;
           }
        }
        //aux accel
        if (signedMotorMoveSpeedTarget2!=signedlastMotorMoveSpeed2)
        {
            if ((signedMotorMoveSpeedTarget2>signedlastMotorMoveSpeed2)&& ((signedMotorMoveSpeedTarget2-signedlastMotorMoveSpeed2)>accelmax2))//accel
            {
                signedMotorMoveSpeedTarget2=signedlastMotorMoveSpeed2+accelmax2;
            }
           
           else if ((signedMotorMoveSpeedTarget2<signedlastMotorMoveSpeed2)&& ((signedlastMotorMoveSpeed2-signedMotorMoveSpeedTarget2)>accelmax2) ) //decel
           {
                signedMotorMoveSpeedTarget2= signedlastMotorMoveSpeed2 -accelmax2;
           }
        }



        
        motors[0].nextMotorMoveSpeed = constrain(abs(signedMotorMoveSpeedTarget0), 0.0f, 65535.0f); //top is 65535
        motors[1].nextMotorMoveSpeed = constrain(abs(signedMotorMoveSpeedTarget1), 0.0f, 65535.0f); //top is 65535
        motors[2].nextMotorMoveSpeed = constrain(abs(signedMotorMoveSpeedTarget2), 0.0f, 65535.0f); //top is 65535
        
        for (int mot=0; mot<3; mot++)
        {
          if (motors[mot].nextMotorMoveSpeed>0) bitSet(motorMoving, mot);
          else bitClear(motorMoving, mot);
          //Serial.print("motorMoving:");Serial.println(motorMoving);
        }
   
      
        motors[0].dir = (signedMotorMoveSpeedTarget0>0) ? 1:0;
        motors[1].dir = (signedMotorMoveSpeedTarget1>0) ? 1:0;
        motors[2].dir = (signedMotorMoveSpeedTarget2>0) ? 1:0;
        
        //don't write digital pins here - allow interrupt loop to do it
        //digitalWrite(motors[0].dirPin, motors[0].dir);
        //digitalWrite(motors[1].dirPin, motors[1].dir);
        //digitalWrite(motors[2].dirPin, motors[2].dir);

        *motorAccumulator[0] = 65535;
        *motorAccumulator[1] = 65535;
        *motorAccumulator[2] = 65535;
   
        
        //This is just to get us into the loop in the interrupt for each motor to check the test.
        motorMoveSteps0=32000;
        motorMoveSteps1=32000;
        motorMoveSteps2=32000;
        
        nextMoveLoaded = true;

  
}
