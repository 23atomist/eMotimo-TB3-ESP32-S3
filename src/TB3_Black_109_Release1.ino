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

/*


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
	
111 Target - Aux Distance with ability for continuous loop - shorten lean.
Add Stopmotion to Inshot menu
Add Brightness to in shot menu

109 Release Notes

-Fixed Aux reverse to work in all cases
-Added ability to reverse AUX_REV to EEPROM direction.
-Added interval change functionality to in shot menu - don't recommend this is used ever unless your shot is already ruined.  Changing anything mid shot will show.
-Added functionality to use left right to set frame to go to.  Can go forward or back.
-Relaxed tight requirements for joystick absolute centering - check
-Fixed motor feedrate issue when Static Time was maxed out.  If you are maxing out your static time by default, you are not using this setting correctly and hurting your shot!  
-Made Static time a max of Interval minus 0.3 seconds to allow at least a .15 second move - check
-Added abs on feedrate min calc to accommodate spurious overrun negatives on SMS shoots resulting in single long frame delays
-Added check on minimum for video to ensure we don't catch 3PT video moves on min calc.
-Added test against power policy for loop 52 (ext triggering)  
-Added ramping and new motor move to starts and ends (decoupled inputs)
-Added coordinated return to start and three axis moves.
-Updated the motorMoving to accurately assign this
-Broke up move profiles.  Added slow down routine to the move to start/move to end.
-Throttled the calc of the move to respect max jog speeds by axis.  If we hit this we indicates "Speed Limit" on video run screen.  If you hit this, lengthen move and/or decrease ramp
-Added to the Setup Menu the Motor Speed parameter - from 2000 to 20000 max to allow folks to tune.the speeds for AUX.  Pan and Tilt are hardcoded.
-Start delay cleaned up and fixed - now down to the second - also a bailout of CZ to get to 5 seconds so you aren't stuck with accidental long delays
-Add Going to End LCD prompt if heading there.
-Target, Go To End. This now works
-Focus on return to start method.  Pause parameters improved to prevent toggling - added CZ released to check for long holds and released.
-Added new Tab for TB3_InShootMenu - just pauses now and only from progstep 50 (regular SMS)
-Added return to start - just called the same routine from the repeat move at the end of the shot - finds start fine (0's) not sure
*/ 

/* 

 =========================================
Main Program
 =========================================
 
*/

#include <Wire.h>
#include <EEPROM.h>
#if !defined(ESP32)
#include <SoftwareSerial.h> 
#include <avr/interrupt.h>
#include <avr/pgmspace.h>
#else
#include <pgmspace.h>
#include "soc/gpio_struct.h" // direct GPIO register access for the stepper ISR
#if defined(USE_USB_HOST) && (USE_USB_HOST == 1)
#include "EspUsbHost.h"
EspUsbHost usbHost;
#else
struct EspUsbHostGamepadEvent {};
#endif
volatile uint8_t g_usb_joy_x = 128;
volatile uint8_t g_usb_joy_y = 128;
volatile uint16_t g_usb_accel_x = 512;
volatile bool g_usb_button_c = false;
volatile bool g_usb_button_z = false;
#endif
#if defined(ESP32)
#include "tb3_web.h"
#include "tb3_ota.h"
#include "tb3_imu.h"
#endif

char lcdbuffer1[20]; //this used to be 16, but increased to 20 do to overflow when we moved to Arduino 1.6 (stalled and failed)

const char setup_0[] PROGMEM = "Setup Complete";   
const char setup_1[] PROGMEM = "    TB3_109";  
const char setup_2[] PROGMEM = "Connect Joystick";
const char setup_3[] PROGMEM = "C-Next Z-Go Back";
const char setup_4[] PROGMEM = "C-Use Stored";
const char setup_5[] PROGMEM = "Z-Reset";
const char setup_6[] PROGMEM = "Params Reset";
const char setup_7[] PROGMEM = "Low Power"; 
const char setup_8[] PROGMEM = "Move to Start Pt";
const char setup_9[] PROGMEM = "Start Pt. Set";
const char setup_10[] PROGMEM = "Move to Point"; 
const char setup_11[] PROGMEM = "Moving to stored";
const char setup_12[] PROGMEM = "end point";
const char setup_13[] PROGMEM = "Confirm or Move";
const char setup_14[] PROGMEM = "C-Next";
const char setup_15[] PROGMEM = "Move to End Pt.";
const char setup_16[] PROGMEM = "End Point Set";
const char setup_17[] PROGMEM = "Set Sht Interval";
const char setup_18[] PROGMEM = "Intval:   .  sec";
const char setup_19[] PROGMEM = " Ext.Trig";
const char setup_20[] PROGMEM = " Video   ";
const char setup_21[] PROGMEM = "Interval Set";
const char setup_22[] PROGMEM = "Set Static Time";
const char setup_23[] PROGMEM = "Stat_T:   .  sec";
const char setup_24[] PROGMEM = " Video   ";
const char setup_25[] PROGMEM = "Static Time Set";
const char setup_26[] PROGMEM = "Set PreFire Time";
const char setup_27[] PROGMEM = " Pre_T:   .  sec";
const char setup_28[] PROGMEM = "Prefire Time Set";
const char setup_29[] PROGMEM = "    Set Ramp";
const char setup_30[] PROGMEM = "Ramp:     Frames";
const char setup_31[] PROGMEM = "Ramp Set";
const char setup_32[] PROGMEM = "Set Move";
const char setup_33[] PROGMEM = "Duration";
const char setup_34[] PROGMEM = "H:MM:SS";
const char setup_35[] PROGMEM = "Duration Set";
const char setup_36[] PROGMEM = "Set Static Lead";
const char setup_37[] PROGMEM = "In/Out Frames";
const char setup_38[] PROGMEM = "In      Out";
const char setup_39[] PROGMEM = "Lead Frames Set";
const char setup_40[] PROGMEM = " Going to Start";
const char setup_41[] PROGMEM = "Review and";
const char setup_42[] PROGMEM = "Confirm Setting";
const char setup_43[] PROGMEM = "Pan Steps:";
const char setup_44[] PROGMEM = "Tilt Steps:";
const char setup_45[] PROGMEM = "Cam Shots:";
const char setup_46[] PROGMEM = "Time:";
const char setup_47[] PROGMEM = "Ready?";
const char setup_48[] PROGMEM = "Press C Button";
const char setup_49[] PROGMEM = "Program Running";
const char setup_50[] PROGMEM = "Waiting for Ext.";
const char setup_51[] PROGMEM = "LeadIn";
const char setup_52[] PROGMEM = "RampUp";
const char setup_53[] PROGMEM = "Linear";
const char setup_54[] PROGMEM = "RampDn";
const char setup_55[] PROGMEM = "LeadOT";
const char setup_56[] PROGMEM = "Finish";
const char setup_57[] PROGMEM = "Center Joystick";
const char setup_58[] PROGMEM = "Program Complete";
const char setup_59[] PROGMEM = " Repeat Press C";
const char setup_60[] PROGMEM = "Battery too low";
const char setup_61[] PROGMEM = "  to continue";
const char setup_62[] PROGMEM = "Pause ";
const char setup_63[] PROGMEM = "Point X Set";
const char setup_64[] PROGMEM = "Using Set Params";
const char setup_65[] PROGMEM = "UpDown  C-Select";
const char setup_66[] PROGMEM = "New   Point Move";
const char setup_67[] PROGMEM = "Enabled";
const char setup_68[] PROGMEM = "Disabled";
const char setup_69[] PROGMEM = "PowerSave";
const char setup_70[] PROGMEM = "Always";
const char setup_71[] PROGMEM = "Program";
const char setup_72[] PROGMEM = "Shoot (accuracy)";
const char setup_73[] PROGMEM = "Shoot (pwr save)";
const char setup_74[] PROGMEM = "Aux Motor:";
const char setup_75[] PROGMEM = "Set Angle o'View";
const char setup_76[] PROGMEM = "C-Set, Z-Reset";
const char setup_77[] PROGMEM = "Pan AOV: ";
const char setup_78[] PROGMEM = "Tilt AOV: ";
const char setup_79[] PROGMEM = "   % Overlap";
const char setup_80[] PROGMEM = "Overlap Set";
const char setup_81[] PROGMEM = "Rev   Point Move";
const char setup_82[] PROGMEM = "DF Slave Mode";
const char setup_83[] PROGMEM = "Setup Menu"; //not sure why this fails
const char setup_84[] PROGMEM = "Panorama";
const char setup_85[] PROGMEM = "AuxDistance";
const char setup_86[] PROGMEM = "Resume";
const char setup_87[] PROGMEM = "Restart";
const char setup_88[] PROGMEM = "Go to Frame";
const char setup_89[] PROGMEM = "Go to End";
const char setup_90[] PROGMEM = "90";
const char setup_91[] PROGMEM = "Track (Web)";



//PROGMEM const char *setup_str[] = {setup_0,setup_1,setup_2,setup_3,setup_4,setup_5,setup_6,setup_7,setup_8,setup_9,setup_10,
PGM_P const setup_str[] PROGMEM ={setup_0,setup_1,setup_2,setup_3,setup_4,setup_5,setup_6,setup_7,setup_8,setup_9,setup_10,	
setup_11,setup_12,setup_13,setup_14,setup_15,setup_16,setup_17,setup_18,setup_19,setup_20,
setup_21,setup_22,setup_23,setup_24,setup_25,setup_26,setup_27,setup_28,setup_29,setup_30,
setup_31,setup_32,setup_33,setup_34,setup_35,setup_36,setup_37,setup_38,setup_39,setup_40,
setup_41,setup_42,setup_43,setup_44,setup_45,setup_46,setup_47,setup_48,setup_49,setup_50,
setup_51,setup_52,setup_53,setup_54,setup_55,setup_56,setup_57,setup_58,setup_59,setup_60,
setup_61,setup_62,setup_63,setup_64,setup_65,setup_66,setup_67,setup_68,setup_69,setup_70,
setup_71,setup_72,setup_73,setup_74,setup_75,setup_76,setup_77,setup_78,setup_79,setup_80,
setup_81,setup_82,setup_83,setup_84,setup_85,setup_86,setup_87,setup_88,setup_89,setup_90,
setup_91};


//Global Parameters 
#define DEBUG 0//
#define DEBUG_MOTOR 0//
#define DEBUG_NC 0 //
#define DEBUG_PANO 0
#define DEBUG_GOTO 0
#define POWERDOWN_LV false //set this to cause the TB3 to power down below 10 volts
#define MAX_MOVE_POINTS 3
#define VIDEO_FEEDRATE_NUMERATOR 375L // Set this for 42000L, or 375L for faster calc moves
#define PAN_MAX_JOG_STEPS_PER_SEC 10000.0
#define TILT_MAX_JOG_STEPS_PER_SEC 10000.0
//#define AUX_MAX_JOG_STEPS_PER_SEC 15000.0 //this is defined in the setup menu now.


//Main Menu Ordering

#define MENU_OPTIONS  9


#define REG2POINTMOVE 0
#define REV2POINTMOVE 1
#define REG3POINTMOVE 2
#define REV3POINTMOVE 3
#define PANOGIGA      4
#define PORTRAITPANO  5
#define DFSLAVE       6
#define SETUPMENU     7
// Appended rather than slotted in next to DFSLAVE on purpose: progtype is
// persisted to EEPROM slot 7 (see TB3_EEPROM.ino), so renumbering the existing
// entries would make an already-fielded rig come up on a different program
// after this flash. New entries go on the end.
#define WEBTRACK      8
#define AUXDISTANCE   99

// progstep parked while Track (Web) runs. Deliberately outside every zone the
// (now-removed) LCD page rotator used to recognize (0/100/200/210/300 idle,
// 50/51/52/250 run), and still outside tb3_program_selectable()'s list, so a
// web program-change cannot reshuffle progtype mid-track. 901-908 are the
// setup menu; 950 is free.
#define WEBTRACK_PROGSTEP 950



//Portrait Pano
#define PanoArrayTypeOptions 5

#define PANO_9ShotCenter	1
#define PANO_25ShotCenter	3
#define PANO_7X3			2
#define PANO_9X5Type1		6
#define PANO_9X5Type2		7
#define PANO_5x5TopThird	4
#define PANO_7X5TopThird	5

//In Program Menu Ordering
#define INPROG_OPTIONS  5    //up this when code for gotoframe

#define INPROG_RESUME       0
#define INPROG_RTS          1 //return to start
#define INPROG_GOTO_END     2 //Go to end
#define INPROG_GOTO_FRAME   3 //go to frame
#define INPROG_INTERVAL     4 //Set Interval
#define INPROG_STOPMOTION   99 //Manual Forward and Back

//Interval Options
#define VIDEO_INTVAL  2
#define EXTTRIG_INTVAL 3
#define MIN_INTERVAL_STATIC_GAP 3  //min gap between interval and static time
//#define STOPMOT //not used

//TB3 section - Black or Orange Port Mapping for Step pins on Stepper Page
#define MOTORS 3
#if defined(ESP32)
#define MOTOR0_STEP  5 
#define MOTOR1_STEP  6 
#define MOTOR2_STEP  7
#define MOTOR0_DIR   10
#define MOTOR1_DIR   38 // GPIO11 output pad damaged (2026-07) - tilt DIR moved to GPIO38 (J3 pin 10)
#define MOTOR2_DIR   12
#define MOTOR_EN     13
#define MOTOR_EN2    14
#define MS1          15 
#define MS2          16 
#define MS3          17
#define IO_2         2 // drives middle of 2.5 mm connector on I/O port
#define IO_3         3 // drives tip of 2.5 mm connector on I/O port
#define CAMERA_PIN   18 // drives tip of 2.5 mm connector
#define FOCUS_PIN    21 // drives  middle of 2.5mm connector
#else
#define MOTOR0_STEP  5 
#define MOTOR1_STEP  6 
#define MOTOR2_STEP  7
#define MOTOR0_DIR   8 
#define MOTOR1_DIR   9 
#define MOTOR2_DIR   10
#define MOTOR_EN  A3
#define MOTOR_EN2  11
#define MS1 A1 
#define MS2 A2 
#define MS3 A2
#define IO_2  2 // drives middle of 2.5 mm connector on I/O port
#define IO_3  3 // drives tip of 2.5 mm connector on I/O port
#define CAMERA_PIN  12 // drives tip of 2.5 mm connector
#define FOCUS_PIN   13 // drives  middle of 2.5mm connector
#endif
#define STEPS_PER_DEG  444.444 //160000 MS per 360 degees = 444.4444444

/*
STEPS_PER_INCH_AUX for various motors with 17 tooth final gear on 5mm pitch belt
Phidgets 99:1	95153
Phidgets 27:1	25676
Phidgets 5:1	4955
20:1 Ratio	19125
10:1 Ratio	9562
*/

#define STEPS_PER_INCH_AUX 19125 //
#define MAX_AUX_MOVE_DISTANCE 311 //(31.1 inches)
//end TB3 section

unsigned long build_version=10952; //this value is compared against what is stored in EEPROM and resets EEPROM and setup values if it doesn't match
unsigned int  intval=2; //seconds x10  - used for the interval prompt and display
unsigned long interval = 2000; //calculated and is in ms
unsigned int  camera_fired     = 0; //number of shots fired
unsigned int  camera_moving_shots = 200; //frames for new duration/frames prompt
unsigned int  camera_total_shots= 0; //used at the end target for camera fired to compare against
unsigned int  overaldur=20; //seconds now for video only
unsigned int  prefire_time = 1; //currently hardcoded here to .1 second - this powers up motor early for the shot
unsigned int  rampval=50;
unsigned int  static_tm=1; //new variable
unsigned int  lead_in=1;
unsigned int  lead_out=1;
unsigned int  start_delay_sec=0;
int aux_dist;

//External Interrupt Variables
volatile int state = 0; //new variable for interrupt
volatile boolean changehappened=false;  //new variable for interrupt
long shuttertimer_open=0;
long shuttertimer_close=0;
boolean ext_shutter_open = false;
int ext_shutter_count = 0;
int ext_hdr_shots = 1; //this is how many shots are needed before moving - leave at one for normal shooting - future functionality with external 

//Start of variables for Pano Mode
unsigned int P2PType=1;  // 0 = no accel, 1= accel
unsigned int PanoPostMoveDelay=200;

//3 Point motor routine values
float motor_steps_pt[MAX_MOVE_POINTS][MOTORS];  // 3 total points.   Start point is always 0.0
float percent; //% through a leg 
unsigned int keyframe[2][6]= {{0,0,0,0,0,0},{0,0,0,0,0,0}}; //this is basically the keyframes {start, end of rampup, start or rampdown, end}   - doesn't vary by motor at this point
float linear_steps_per_shot [MOTORS] = {0.0,0.0,0.0}; //{This is for the calculated or estimated steps per shot in a segment for each motor
float ramp_params_steps [MOTORS] = {0.0,0.0,0.0}; //This is to calc the steps at the end of rampup for each motor.  Each array value is for a motor

//Program Status Flags
boolean Program_Engaged=false;
boolean Shot_Sequence_Engaged=false;
boolean Prefire_Engaged=false;
boolean Shutter_Signal_Engaged=false;
boolean Static_Time_Engaged=false;
boolean IO_Engaged=false;
boolean Move_Engaged=false;
boolean Interrupt_Fire_Engaged=false;

//Timer2flags
unsigned long MsTimer2_msecs;
//void (*MsTimer2_func)();
volatile unsigned long MsTimer2_count;
volatile char MsTimer2_overflowing;
volatile unsigned int MsTimer2_tcnt2;

//New Powersave flags
/*Power Save explanation
We can power up and power down the Pan Tilt motors together.  We can power up and power down the Aux motor port as well.  We see three levels of power saving:
1)  None - Motors are always on - for VFX work where power isn't a factor and precision is most important.  Motors will get warm here on hot days.
2)  Low - only at the end of program 
3)  Standard - Power up the motors for the shooting time (all the time we hold the trigger down), and move, power down between shots.
4)  High - Only power on for motor moves, turn off the motors when we reach the shooting position.  
    We are powered down for the shot and only power on for moves. This saves a ton of battery for long astro shots.   
    We do lose microstep resolution for this, but it usually is not visible.   We could be off by as much as 8/16 mircosetps for a shot or 0.018 degrees - Really small stuff!  Try this mode out!
*/


//CVariables that are set during the Setup Menu store these in EEPROM
unsigned int  POWERSAVE_PT;  //1=None - always on  2 - low   3=standard    4=High
unsigned int  POWERSAVE_AUX;  //1=None - always on  2 - low   3=standard    4=High
byte AUX_ON;  //1=Aux Enabled, 2=Aux disabled
byte PAUSE_ENABLED;  //1=Pause Enabled, 0=Pause disabled
boolean REVERSE_PROG_ORDER; //Program ordering 0=normal, start point first. 1=reversed, set end point first to avoid long return to start
boolean MOVE_REVERSED_FOR_RUN=0;
unsigned int  LCD_BRIGHTNESS_DURING_RUN;  //0 is off 8 is max
unsigned int  AUX_MAX_JOG_STEPS_PER_SEC; //value x 1000  20 is the top or 20000 steps per second.
byte AUX_REV;  //1=Aux Enabled, 2=Aux disabled


//control variable, no need to store in EEPROM - default and setup during shot
unsigned int progstep = 0; //used to define case for main loop
boolean progstep_forward_dir=true; //boolean to define direction of menu travel to allow for easy skipping of menus
unsigned int progtype=0; //updownmenu selection
int inprogtype=0; //updownmenu selection during shoot
boolean reset_prog=1; //used to handle program reset or used stored
unsigned int first_time=1; //variable to help with LCD dispay variable that need to show one time
boolean first_time2=true;
int batt_low_cnt=0;
unsigned int max_shutter;
unsigned int max_prefire;
unsigned int program_progress_2PT=1;  //Lead in, ramp, linear, etc for motor routine case statement
unsigned int program_progress_3PT=1;  //phase 1, phase 2
unsigned long interval_tm        = 0;  //mc time to help with interval comparison
unsigned long interval_tm_last =0; //mc time to help with interval comparison
int cursorpos=1; //use 1 for left, 2 for right  - used for lead in, lead out
unsigned int lcd_dim_tm     = 10;
unsigned long input_last_tm = 0;
unsigned long diplay_last_tm = 0;
unsigned int  lcd_backlight_cur=100;
unsigned int  prompt_time=500; // in ms for delays of instructions
//unsigned int  prompt_time=350; // for faster debugging
int  prompt_delay = 0; //to help with joystick reads and delays for inputs - this value is set during joystick read and executed later in the loop
int prompt_val;
unsigned int  video_sample_ms=100; //
unsigned int video_segments=150; //arbitrary
int reviewprog = 1;
//variables for display of remaining time
int timeh; 
int timem;
int time_s;

unsigned long start_delay_tm = 0;  //ms timestamp to help with delay comparison
unsigned int goto_shot=0;

int sequence_repeat_type=1; //1 Defaults - Run Once, 0 Continuous Loop,  -1 Continuous Forward
int sequence_repeat_count=0; //counter to hold variable for how many time we have repeated



//remote and interface variables

float joy_x_axis; int joy_x_axis_Offset; int joy_x_axis_Bucket; int joy_x_axis_Threshold; int joy_x_axis_map; int speedx;
float joy_y_axis; int joy_y_axis_Offset; int joy_y_axis_Bucket; int joy_y_axis_Threshold; int joy_y_axis_map; int speedy;
float accel_x_axis; int accel_x_axis_Offset; int accel_x_axis_Bucket; int accel_x_axis_Threshold;

int PanStepCount;
int TiltStepCount;

int z_button = 0;
int c_button = 0;
int prev_joy_x_reading=0;
int prev_joy_y_reading=0;
unsigned int joy_y_lock_count=0;
unsigned int joy_x_lock_count=0;
int prev_accel_x_reading=0;
int CZ_Button_Read_Count=0;
boolean CZ_Released=true;
int C_Button_Read_Count=0;
boolean C_Released=true;
int Z_Button_Read_Count=0;
boolean Z_Released=true;
int NCReadStatus=0; //control variable for NC error handling
unsigned int NCReadMillis=42; //frequency at which we read the nunchuck for moves  1000/24 = 42  1000/30 = 33
long NClastread=1000; //control variable for NC reads cycles




//Stepper Setup
unsigned long  feedrate_micros = 0;

struct FloatPoint {
	float x;
	float y;
 	float z;
};
FloatPoint fp;

FloatPoint current_steps;
FloatPoint target_steps;
FloatPoint delta_steps;

#if defined(ESP32)
// The Xtensa FPU is unavailable in ISR context, so the 40kHz stepper ISR
// cannot touch the float current_steps directly (Coprocessor exception).
// It accumulates integer deltas here; sync_isr_steps() folds them into
// current_steps from task context.
volatile int32_t isr_step_delta[3] = {0, 0, 0};

void sync_isr_steps()
{
  noInterrupts();
  int32_t dx = isr_step_delta[0]; isr_step_delta[0] = 0;
  int32_t dy = isr_step_delta[1]; isr_step_delta[1] = 0;
  int32_t dz = isr_step_delta[2]; isr_step_delta[2] = 0;
  interrupts();
  current_steps.x += dx;
  current_steps.y += dy;
  current_steps.z += dz;
}

// ISR-safe pin write: single register access, no flash-resident framework
// code and no error-log path (both crash or watchdog a 40kHz ISR).
void IRAM_ATTR fast_gpio_write(uint8_t pin, bool level)
{
  if (pin < 32) {
    if (level) GPIO.out_w1ts = (1UL << pin);
    else       GPIO.out_w1tc = (1UL << pin);
  } else {
    if (level) GPIO.out1_w1ts.val = (1UL << (pin - 32));
    else       GPIO.out1_w1tc.val = (1UL << (pin - 32));
  }
}
#endif

//our direction vars
byte x_direction = 1;
byte y_direction = 1;
byte z_direction = 1;

//End setup of Steppers

//Start of DF Vars
#define DFMOCO_VERSION 1
#define DFMOCO_VERSION_STRING "1.2.6"


// supported boards
#define ARDUINO      1
#define ARDUINOMEGA  2

//eMotimo TB3 - Set this PINOUT_VERSION 3 for TB3 Orange (Uno)
//eMotimo TB3 - Set this PINOUT_VERSION 4 for TB3 Black (MEGA)
#define PINOUT_VERSION 3

/*
  This is PINOUT_VERSION 1
  
  channel 5
        PIN  22   step
        PIN  23   direction
  channel 6
        PIN  24   step
        PIN  25   direction
  channel 7
        PIN  26   step
        PIN  27   direction
  channel 8
        PIN  28   step
        PIN  29   direction
*/

// detect board type
#if defined(ESP32)
#define BOARD 99
#else
#define BOARD ARDUINOMEGA
#endif

#define SERIAL_DEVICE Serial
  
#define PIN_ON(port, pin)  { port |= pin; }
#define PIN_OFF(port, pin) { port &= ~pin; }

#define MOTOR_COUNT 4

// TB3 hardware has 3 physical motor drivers. Axis 4 (pins 30/31) was an
// AVR-Mega debug channel; on ESP32-S3 GPIO30/31 are SPI flash pins and pin
// masks like B10000000 (=128) are invalid GPIOs, so never touch axis 4 pins.
#if defined(ESP32)
#define PHYS_MOTOR_COUNT 3
#else
#define PHYS_MOTOR_COUNT MOTOR_COUNT
#endif

#define TIME_CHUNK 50
#define SEND_POSITION_COUNT 20000

// update velocities 20 x second
#define VELOCITY_UPDATE_RATE (50000 / TIME_CHUNK)
#define VELOCITY_INC(maxrate) (max(1.0f, maxrate / 70.0f))


  //Start TB3 Black Port Mapping

  #define MOTOR0_STEP_PORT PORTE
  #define MOTOR0_STEP_PIN  B00001000 //Pin 5 PE3
  
  #define MOTOR1_STEP_PORT PORTH
  #define MOTOR1_STEP_PIN  B00001000//Pin  6 PH3
  
  #define MOTOR2_STEP_PORT PORTH
  #define MOTOR2_STEP_PIN  B00010000 //Pin 7 PH4

  #define MOTOR3_STEP_PORT PORTC //  Map this to pin 30 PC7 on the Mega board for debug
  #define MOTOR3_STEP_PIN  B10000000 //
  //End TB3 Black Port Mapping


/**
 * Serial output specialization
 */
#if defined(UBRRH)
#define TX_UCSRA UCSRA
#define TX_UDRE  UDRE
#define TX_UDR   UDR
#else
#define TX_UCSRA UCSR0A
#define TX_UDRE  UDRE0
#define TX_UDR   UDR0
#endif
 
char txBuf[32];
char *txBufPtr;

#define TX_MSG_BUF_SIZE 16

#define MSG_STATE_START 0
#define MSG_STATE_CMD   1
#define MSG_STATE_DATA  2
#define MSG_STATE_ERR   3

#define MSG_STATE_DONE  100

/*
 * Command codes from user
 */
#define USER_CMD_ARGS 40

#define CMD_NONE       0
#define CMD_HI         10
#define CMD_MS         30
#define CMD_NP         31
#define CMD_MM         40 // move motor
#define CMD_PR         41 // pulse rate
#define CMD_SM         42 // stop motor
#define CMD_MP         43 // motor position
#define CMD_ZM         44 // zero motor
#define CMD_SA         50 // stop all (hard)
#define CMD_BF         60 // blur frame
#define CMD_GO         61 // go!

#define CMD_JM         70 // jog motor
#define CMD_IM         71 // inch motor

#define MSG_HI 01
#define MSG_MM 02
#define MSG_MP 03
#define MSG_MS 04
#define MSG_PR 05
#define MSG_SM 06
#define MSG_SA 07
#define MSG_BF 10
#define MSG_GO 11
#define MSG_JM 12
#define MSG_IM 13


struct UserCmd
{
  byte command;
  byte argCount;
  int32_t args[USER_CMD_ARGS];
} ;

/*
 * Message state machine variables.
 */
byte lastUserData;
int  msgState;
int  msgNumberSign;
UserCmd userCmd;


struct txMsg
{
  byte msg;
  byte motor;
};

struct TxMsgBuffer
{
  txMsg buffer[TX_MSG_BUF_SIZE];
  byte head;
  byte tail;
};

TxMsgBuffer txMsgBuffer;


/*
 Motor data.
 */

uint16_t           motorAccumulator0;
uint16_t           motorAccumulator1;
uint16_t           motorAccumulator2;
uint16_t           motorAccumulator3;

uint16_t*          motorAccumulator[MOTOR_COUNT] =
{
  &motorAccumulator0, &motorAccumulator1, &motorAccumulator2, &motorAccumulator3, 

};

uint16_t           motorMoveSteps0;
uint16_t           motorMoveSteps1;
uint16_t           motorMoveSteps2;
uint16_t           motorMoveSteps3;

uint16_t*          motorMoveSteps[MOTOR_COUNT] =
{
  &motorMoveSteps0, &motorMoveSteps1, &motorMoveSteps2, &motorMoveSteps3,
};


uint16_t           motorMoveSpeed0;
uint16_t           motorMoveSpeed1;
uint16_t           motorMoveSpeed2;
uint16_t           motorMoveSpeed3;

uint16_t         * motorMoveSpeed[MOTOR_COUNT] =
{
  &motorMoveSpeed0, &motorMoveSpeed1, &motorMoveSpeed2, &motorMoveSpeed3,

};

volatile boolean nextMoveLoaded;


unsigned int   velocityUpdateCounter;
byte           sendPositionCounter;
boolean        hardStopRequested;

byte sendPosition = 0;
byte motorMoving = 0;
byte toggleStep = 0;


#define P2P_MOVE_COUNT 7

struct Motor
{
  byte   stepPin;
  byte   dirPin;

  // pre-computed move
  float   moveTime[P2P_MOVE_COUNT];
  int32_t movePosition[P2P_MOVE_COUNT];
  float   moveVelocity[P2P_MOVE_COUNT];
  float   moveAcceleration[P2P_MOVE_COUNT];

  float   gomoMoveTime[P2P_MOVE_COUNT];
  int32_t gomoMovePosition[P2P_MOVE_COUNT];
  float   gomoMoveVelocity[P2P_MOVE_COUNT];
  float   gomoMoveAcceleration[P2P_MOVE_COUNT];

  int       currentMove;
  float     currentMoveTime;
  
  volatile  boolean   dir;

  int32_t   position;
  int32_t   destination;
  
  float     maxVelocity;     //Orig - delete later
  float     maxAcceleration; //Orig - delete later
  
  float     moveMaxVelocity;     //Pass this into calculator for synchronized moves
  float     moveMaxAcceleration; //Pass this into calculator for synchronized moves
  
  float     jogMaxVelocity; //replaced the original maxVelocity
  float     jogMaxAcceleration; //replaced the original maxAcceleration
 
  uint16_t  nextMotorMoveSteps;
#if defined(ESP32)
  uint16_t  nextMotorMoveSpeed; // read by the 40kHz ISR: float here causes a Coprocessor exception (no FPU in ISRs)
#else
  float     nextMotorMoveSpeed;
#endif
  

};

boolean maxVelLimit=false;

boolean goMoReady;
int     goMoDelayTime;

Motor motors[MOTOR_COUNT];

//End of DFVars


/* 
 =========================================
 Setup functions
 =========================================
*/



void setup() {
  Serial.begin(57600);
  delay(50); // Give serial connection time to initialize
  Serial.println("\n[eMotimo ESP32] Booting Setup...");
#if defined(ESP32)
  Serial.println("[eMotimo ESP32] Initializing EEPROM...");
  EEPROM.begin(512);
#endif
  
  Serial.println("[eMotimo ESP32] Configuring pin modes...");
  // setup motor pins
 pinMode(MOTOR0_STEP, OUTPUT);
 pinMode(MOTOR0_DIR, OUTPUT);
 pinMode(MOTOR1_STEP, OUTPUT);
 pinMode(MOTOR1_DIR, OUTPUT);
 pinMode(MOTOR2_STEP, OUTPUT);
 pinMode(MOTOR2_DIR, OUTPUT);
 
pinMode(MS1,OUTPUT);
pinMode(MS2,OUTPUT);
pinMode(MS3,OUTPUT);
 
digitalWrite(MS1, HIGH);
digitalWrite(MS2, HIGH);
digitalWrite(MS3, HIGH);

 pinMode(MOTOR_EN, OUTPUT);
 pinMode(MOTOR_EN2, OUTPUT);
 digitalWrite(MOTOR_EN, HIGH); //LOW Enables output, High Disables
 digitalWrite(MOTOR_EN2, HIGH); //LOW Enables output, High Disables
 
// setup camera pins
 pinMode(CAMERA_PIN, OUTPUT); 
 pinMode(FOCUS_PIN, OUTPUT); 
 
digitalWrite(CAMERA_PIN, LOW);
digitalWrite(FOCUS_PIN, LOW);

//Setup of I/0 Pings Start with output of I/Oport
pinMode(IO_2, OUTPUT);
pinMode(IO_3, OUTPUT);

digitalWrite(IO_2, LOW);
digitalWrite(IO_3, LOW);

pinMode(A0, INPUT); //this is for the voltage reading

//Setup Serial Connection

//if (DEBUG) Serial.begin(115200);
Serial.println("Serial Port is open");

// Handle EEPROM Interaction and upgrades

//Check to see if our hardcoded build version set in progam is different than what was last put in EEPROM - detect upgrade.
if(build_version != check_version()) { //4 byte string that now holds the build version.
  if(DEBUG) Serial.println(check_version());
  if(DEBUG) Serial.println("Upgrading Memory");   
  write_defaults_to_eeprom_memory();  //these are for setting for last shot
  set_defaults_in_setup(); //this is for our setup values that should only be defaulted once.
  //review_RAM_Contents();
}
else { //load last setting into memory - no upgrade
   if(DEBUG) Serial.println("Restoring EEPROM Values");
   restore_from_eeprom_memory();
   //review_RAM_Contents();
 }
//End Setup of EEPROM

///begin  Setup for Nunchuck
#if !defined(ESP32)
Nunchuck.init(0);
delay(50);
for (int reads=1; reads<17; reads++) {
   Nunchuck.getData();
   //Nunchuck.printData();
   if (abs(Nunchuck.joyx()-127)>60||abs(Nunchuck.joyy()-127)>60 ){
     reads=1;
   }
   delay(10);

}

calibrate_joystick(Nunchuck.joyx(),Nunchuck.joyy());
#else
#if defined(USE_USB_HOST) && (USE_USB_HOST == 1)
// ESP32 USB Host Gamepad initialization
usbHost.begin();
extern void init_usb_joystick();
init_usb_joystick();
#endif
for (int reads=1; reads<17; reads++) {
   delay(50);
}
calibrate_joystick(128,128);
#endif

 //end  Setup for Nunchuk


//Setup Motors  
init_steppers();
#if defined(ESP32)
extern void setupstartISR1();
setupstartISR1();
#endif

//init_external_triggering();
pinMode(IO_3, INPUT);
digitalWrite(IO_3, HIGH);
#if defined(ESP32)
attachInterrupt(digitalPinToInterrupt(IO_3), cam_change, CHANGE);
#else
attachInterrupt(1, cam_change, CHANGE);
#endif

#if defined(ESP32)
// Network control surface (inputs are injected through the virtual
// joystick in NunChuckQuerywithEC, so all menus work remotely)
tb3_web_begin();
tb3_imu_begin();
tb3_ota_mark_setup_done();
#endif

} //end of setup

void loop() {  //Main Loop
  while(1) {  //use debugging WHEN HIT here for monitoring - {sequence_repeat_type},{progstep},{progtype},{camera_fired}
    #if defined(ESP32)
    delay(1);
    tb3_ota_health_tick();
    #endif
    switch (progstep) 
    {

 //start of 2 point SMS/Video routine
      case 0:   //
        tb3_idle_dispatch();
		
      break;
    } //switch
  } // while
} //loop

