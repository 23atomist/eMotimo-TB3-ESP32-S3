/*
  DFMoco version 1.2.6
  
  Multi-axis motion control.
  For use with the Arc motion control system in Dragonframe 3.
  Generates step and direction signals, which can be sent to stepper motor drivers.
   
  Control up to four axes with an Uno or Duemilanove board.
  Control up to eight axes with a Mega or Mega 2560, chipKit MAX32 or LeafLabs Maple.

  Version History
  
  Version 1.2.6 Add PINOUT_VERSION option to use older pinout.
  Version 1.2.5 Fix jogging with low pulse rate.
  Version 1.2.4 Fix pin assignments
  Version 1.2.3 New Position command
  Version 1.2.2 Jog and Inch commands
  Version 1.2.1 Moved step/direction pins for motions 5-8.
                Detects board type automatically.
  Version 1.2.0 Basic go-motion capabilities
  Version 1.1.2 Smooth transitions when changing direction
  Version 1.1.1 Save/restore motor position
  Version 1.1.0 Major rework 
  Version 1.0.2 Moved pulses into interrupt handler
  Version 1.0.1 Added delay for pulse widths  
  Version 1.0.0 Initial public release.

  Pin configuration for TB3 Orange:
    
  #define MOTOR0_STEP  5   //Pin 5 is PORTD B00100000
  #define MOTOR0_DIR   8 
  #define MOTOR1_STEP  6   //Pin 6 is PORTD B01000000
  #define MOTOR1_DIR   9 
  #define MOTOR2_STEP  7   //Pin 7 is PORTD B10000000
  #define MOTOR2_DIR   10
  
  
  #define MOTOR_EN     17
  #define MOTOR_EN_2   11
  
  #define MS1           15
  #define MS2_3         16

  #define CAMERA_PIN  12 // drives tip of 2.5 mm connector
  #define FOCUS_PIN   13 // drives  middle of 2.5 connector
  
  
  Pin configuration for TB3 Black:
    
  #define MOTOR0_STEP  5   //Pin 5 is PORTE B00001000 PE3
  #define MOTOR0_DIR   8 
  #define MOTOR1_STEP  6   //Pin 6 is PORTH B00001000 PH3
  #define MOTOR1_DIR   9 
  #define MOTOR2_STEP  7   //Pin 7 is PORTH B00010000 PH4
  #define MOTOR2_DIR   10
  #define MOTOR3_STEP  30  //Pin 30 is PC7 PORTC B10000000
  #define MOTOR3_DIR   31
  
  #define MOTOR_EN     A3
  #define MOTOR_EN_2   11 
  
  #define MS1           A1
  #define MS2           A2 
  #define MS3           A2

  #define CAMERA_PIN  12 // drives tip of 2.5 mm connector
  #define FOCUS_PIN   13 // drives  middle of 2.5 connector        
      
 */  


#ifdef KILL_SWITCH_INTERRUPT
void killSwitch()
{
  hardStopRequested = true;
}
#endif




void DFSetup()
{
  
  //delay(1000);
  //lcd.setup();  
  //delay(100);
  
  //lcd.empty();
  //if (PINOUT_VERSION == 4)  lcd.at(1,1,"eMotimo TB3Black");
  //if (PINOUT_VERSION == 3)  lcd.at(1,1,"eMotimoTB3Orange");
  //lcd.at(2,1,"Dragonframe 1.26");
  
  
  goMoReady = false;
  lastUserData = 0;
  msgState = MSG_STATE_START;
  velocityUpdateCounter = 0;
  sendPositionCounter = 10;
  nextMoveLoaded = false;
  hardStopRequested = false;
  motorMoving=0;//eMotimo added - 
  

  for (int i = 0; i < 32; i++)
    txBuf[i] = 0;
  
  txBufPtr = txBuf;
  
  #ifdef KILL_SWITCH_INTERRUPT
  attachInterrupt(KILL_SWITCH_INTERRUPT, killSwitch, CHANGE);
  #endif
  
  // initialize motor structures
  for (int i = 0; i < MOTOR_COUNT; i++)
  {
    // setup motor pins - you can customize/modify these after loop
    // default sets step/dir pairs together, with first four motors at 4/5, 6/7, 8/9, 10/11
    // then, for the Mega boards, it jumps to 28/29, 30/31, 32/33, 34/35
    #if ( PINOUT_VERSION == 2 )
      motors[i].stepPin = (i * 2) + ( (i < 4) ? 4 : 20 );
    #elif ( PINOUT_VERSION == 1 )
      motors[i].stepPin = (i * 2) + ( (i < 4) ? 4 : 14 );
    #endif
    
    motors[i].dirPin = motors[i].stepPin + 1;
    motors[i].dir = true; // forward
    motors[i].position = 0L;
    motors[i].destination = 0L;

    motors[i].nextMotorMoveSteps = 0;
    motors[i].nextMotorMoveSpeed = 0;
    
    setPulsesPerSecond(i, 5000);
  }
//Hardcode Max Jog Speeds to start
motors[0].jogMaxVelocity=PAN_MAX_JOG_STEPS_PER_SEC;
motors[0].jogMaxAcceleration=PAN_MAX_JOG_STEPS_PER_SEC/2;

motors[1].jogMaxVelocity=TILT_MAX_JOG_STEPS_PER_SEC;
motors[1].jogMaxAcceleration=TILT_MAX_JOG_STEPS_PER_SEC/2;

motors[2].jogMaxVelocity=AUX_MAX_JOG_STEPS_PER_SEC;
motors[2].jogMaxAcceleration=AUX_MAX_JOG_STEPS_PER_SEC/2;

//TB3  Specific Setup Pins (Same for Orange and Black
  motors[0].stepPin = MOTOR0_STEP;
  motors[0].dirPin = MOTOR0_DIR;
  motors[1].stepPin = MOTOR1_STEP;
  motors[1].dirPin = MOTOR1_DIR;
  motors[2].stepPin = MOTOR2_STEP;
  motors[2].dirPin = MOTOR2_DIR;
#if !defined(ESP32) // GPIO30/31 are SPI flash pins on ESP32-S3 - never configure them
  motors[3].stepPin = 30; //just for debug
  motors[3].dirPin = 31;
#endif


  // set output pins
  for (int i = 0; i < PHYS_MOTOR_COUNT; i++)
  {
    pinMode(motors[i].stepPin, OUTPUT);
    pinMode(motors[i].dirPin, OUTPUT);
    
#if defined(__AVR_ATmega1280__) || defined(__AVR_ATmega2560__)

    // disable PWM
    switch (motors[i].stepPin)
    {
      #if defined(TCCR3A) && defined(COM3B1)
      case 4:
        TCCR3A &= ~COM3B1;
        break;
      #endif

      #if defined(TCCR4A) && defined(COM4A1)
      case 6:
        TCCR4A &= ~COM4A1;
        break;
      #endif

      #if defined(TCCR4A) && defined(COM4C1)
      case 8:
        TCCR4A &= ~COM4C1;
        break;
      #endif

      #if defined(TCCR2A) && defined(COM2A1)
      case 10:
        TCCR2A &= ~COM2A1;
        break;
      #endif
    }
    
#else
    
    switch (motors[i].stepPin)
    {
      #if defined(TCCR1A) && defined(COM1B1)
      case 10:
        TCCR1A &= ~COM1B1;
        break;
      #endif

    }

#endif
  }
  
  // set initial direction
  for (int i = 0; i < PHYS_MOTOR_COUNT; i++)
  {
    digitalWrite( motors[i].dirPin, motors[i].dir ? HIGH : LOW );
  }

  
  //Setup TB3 Specific Parameters

//Setup Microstepping
/*  
pinMode(MS1,OUTPUT); //MS1
pinMode(MS2,OUTPUT); //MS2 for Motor 2
pinMode(MS3,OUTPUT); //MS3 for Motor 2
 
digitalWrite(MS1, HIGH); //set to microstep 16
digitalWrite(MS2, HIGH); //set to microstep 16
digitalWrite(MS3, HIGH); //set to microstep 16

//Turn off LED's  
pinMode(CAMERA_PIN,OUTPUT);
digitalWrite(CAMERA_PIN, LOW); //turn off the LEDs
pinMode(FOCUS_PIN,OUTPUT);
digitalWrite(FOCUS_PIN, LOW); //turn off the LEDs
  
//Enable the Motors
pinMode(MOTOR_EN,OUTPUT);
digitalWrite(MOTOR_EN, LOW); //Enable the motors 0 and 1
pinMode(MOTOR_EN2,OUTPUT);
digitalWrite(MOTOR_EN2, LOW); //Enable the motors 2 

*/ //comment variable redefinition out as this is setup on start.

//turn on the motors
enable_PT();
enable_AUX();
  
  
  
  // setup serial connection
  #if (BOARD == ARDUINO) || (BOARD == ARDUINOMEGA) || (BOARD == CHIPKITMAX32)
  Serial.begin(57600);
  #endif

  sendMessage(MSG_HI, 0);
    
  // SET UP interrupt timer

  #if (BOARD == ARDUINO) || (BOARD == ARDUINOMEGA)

    TCCR1A = 0;
    TCCR1B = _BV(WGM13);

    ICR1 = (F_CPU / 4000000) * TIME_CHUNK; // goes twice as often as time chunk, but every other event turns off pins
    TCCR1B &= ~(_BV(CS10) | _BV(CS11) | _BV(CS12));
    TIMSK1 = _BV(TOIE1);
    TCCR1B |= _BV(CS10);


  #endif

  #if defined(ESP32)
    // On AVR the block above leaves TIMER1 free-running from DFSetup() on.
    // The jog/velocity screens depend on that: the ISR clears nextMoveLoaded
    // every 25ms, which is what lets the jog loops re-read input and load
    // the next velocity segment. Without this the screens freeze after one
    // pass (no motion, buttons dead). Mirror the AVR behavior.
    startISR1();
  #endif
}







#if defined(ESP32)
void IRAM_ATTR onTimer() //timer interrupt
#else
ISR(TIMER1_OVF_vect) //timer interrupt
#endif
{
  toggleStep = !toggleStep;
  
  if (toggleStep)
  {
    //PIN_ON(MOTOR3_STEP_PORT, MOTOR3_STEP_PIN); // this is just for clock cycle mapping
    // MOTOR 1
    if (motorMoveSteps0)
    {
      uint16_t a = motorAccumulator0;
      motorAccumulator0 += motorMoveSpeed0;
      if (motorAccumulator0 < a)
      {
        motorMoveSteps0--;

        PIN_ON(MOTOR0_STEP_PORT, MOTOR0_STEP_PIN);
#if defined(ESP32) // no FPU in ISRs - track steps as integers, sync later
        if (motors[0].dir) isr_step_delta[0]++;
        else isr_step_delta[0]--;
#else
        if (motors[0].dir) current_steps.x++;
        else current_steps.x--;
#endif
      }
    }

    // MOTOR 2
    if (motorMoveSteps1)
    {
      uint16_t a = motorAccumulator1;
      motorAccumulator1 += motorMoveSpeed1;
      if (motorAccumulator1 < a)
      {
        motorMoveSteps1--;

        PIN_ON(MOTOR1_STEP_PORT, MOTOR1_STEP_PIN);

#if defined(ESP32) // no FPU in ISRs - track steps as integers, sync later
        if (motors[1].dir) isr_step_delta[1]++;
        else isr_step_delta[1]--;
#else
        if (motors[1].dir) current_steps.y++;
        else current_steps.y--;
#endif
      }
    }

    // MOTOR 3
    if (motorMoveSteps2)
    {
      uint16_t a = motorAccumulator2;
      motorAccumulator2 += motorMoveSpeed2;
      if (motorAccumulator2 < a)
      {
        motorMoveSteps2--;

        PIN_ON(MOTOR2_STEP_PORT, MOTOR2_STEP_PIN);

#if defined(ESP32) // no FPU in ISRs - track steps as integers, sync later
        if (motors[2].dir) isr_step_delta[2]++;
        else isr_step_delta[2]--;
#else
        if (motors[2].dir) current_steps.z++;
        else current_steps.z--;
#endif
      }
    }

#if !defined(ESP32) // no physical motor 4 on ESP32 - pin mask 128 is not a valid GPIO
    // MOTOR 4
    if (motorMoveSteps3)
    {
      uint16_t a = motorAccumulator3;
      motorAccumulator3 += motorMoveSpeed3;
      if (motorAccumulator3 < a)
      {
        motorMoveSteps3--;

        PIN_ON(MOTOR3_STEP_PORT, MOTOR3_STEP_PIN);
      }
    }
#endif


  }
  else
  {
    velocityUpdateCounter++;
    if (velocityUpdateCounter == VELOCITY_UPDATE_RATE)
    {
      velocityUpdateCounter = 0;
      
      if (sendPositionCounter)
      {
        sendPositionCounter--;
      }
      
      for (int i = 0; i < MOTOR_COUNT; i++)
      {
        if (*motorMoveSpeed[i] && !motors[i].nextMotorMoveSpeed)
        {
          bitSet(sendPosition, i);
        }

        *motorMoveSteps[i] = motors[i].nextMotorMoveSteps;
        *motorMoveSpeed[i] = motors[i].nextMotorMoveSpeed;
#if defined(ESP32) // ISR-safe register write instead of framework digitalWrite
        if (i < PHYS_MOTOR_COUNT) fast_gpio_write(motors[i].dirPin, motors[i].dir);
#else
        digitalWrite(motors[i].dirPin, motors[i].dir);
#endif

        *motorAccumulator[i] = 65535;
      }
      nextMoveLoaded = false; // ready for new move
    }
    
    PIN_OFF(MOTOR0_STEP_PORT, MOTOR0_STEP_PIN);
    PIN_OFF(MOTOR1_STEP_PORT, MOTOR1_STEP_PIN);
    PIN_OFF(MOTOR2_STEP_PORT, MOTOR2_STEP_PIN);
#if !defined(ESP32) // no physical motor 4 on ESP32 - pin mask 128 is not a valid GPIO
    PIN_OFF(MOTOR3_STEP_PORT, MOTOR3_STEP_PIN);
#endif

    
  }
}

/**
 * Update velocities.
 */

void updateMotorVelocities()
{
#if defined(ESP32)
  sync_isr_steps(); // keep float current_steps fresh while the ISR runs
#endif
  // process hard stop interrupt request
  if (hardStopRequested)
  {
    hardStopRequested = 0;
    hardStop();
  }
  
  for (int m = 0; m < MOTOR_COUNT; m++)
  {
    motors[m].nextMotorMoveSteps = 0;
    motors[m].nextMotorMoveSpeed = 0;

    if (bitRead(motorMoving, m))
    {
      Motor *motor = &motors[m];
      int seg = motor->currentMove;
      
      if (motor->moveTime[seg] == 0)
      {
        motors[m].nextMotorMoveSpeed = 0;
        bitClear(motorMoving, m);
      }
      else
      {
        motor->currentMoveTime += 0.05f;
        
        if (motor->currentMoveTime >= motor->moveTime[seg])
        {
          motor->currentMoveTime -= motor->moveTime[seg];
          motor->currentMove++;
          seg++;
        }
        float t = motor->currentMoveTime;
        int32_t xn = (int32_t)(motor->movePosition[seg] + motor->moveVelocity[seg] * t + motor->moveAcceleration[seg] * t * t); // accel was already multiplied * 0.5

        int32_t dx = abs(xn - motor->position);

        motors[m].nextMotorMoveSpeed = max(1, (int)min(65535, (int)(dx * 65.6f)));
        motors[m].nextMotorMoveSteps = dx;

        boolean forward = xn > motor->position;
        motors[m].dir = forward;

        motor->position = xn;
      }
    }//end if motor moving
    
  }//end motor count routine

  
  nextMoveLoaded = true;
}

/*
 * Set up the axis for pulses per second (approximate)
 */
void setPulsesPerSecond(int motorIndex, uint16_t pulsesPerSecond)
{
  if (pulsesPerSecond > 20000)
    pulsesPerSecond = 20000;
  if (pulsesPerSecond < 100)
    pulsesPerSecond = 100;
    
  uint16_t itersPerSecond = 1000000L / TIME_CHUNK;
  
  motors[motorIndex].maxVelocity = pulsesPerSecond;
  motors[motorIndex].maxAcceleration = pulsesPerSecond * 0.5f;  
}


void setupMotorMove(int motorIndex, int32_t destination)
{
  motors[motorIndex].destination = destination;

  if ( destination != motors[motorIndex].position )
  {
    calculatePointToPoint(motorIndex, destination);
    bitSet(motorMoving, motorIndex);
  }

}


void hardStop()
{
  // set the destination to the current location, so they won't move any more
  for (int i = 0; i < MOTOR_COUNT; i++)
  {
    stopMotor(i);
  }
}

void stopMotor(int motorIndex)
{
  int32_t delta = (motors[motorIndex].destination - motors[motorIndex].position);
  if (!delta)
    return;

  Motor *motor = &motors[motorIndex];
  int i;

  for (i = 0; i < P2P_MOVE_COUNT; i++)
  {
    motor->moveTime[i] = 0;
    motor->moveVelocity[i] = 0;
    motor->movePosition[i] = 0;
  }

  float v = 20 * motors[motorIndex].nextMotorMoveSpeed / (float)65.536;
  float maxA = motor->maxAcceleration;
  float maxV = motor->maxVelocity;

  if (v > maxV)
    v = maxV;

  if (!motor->dir)
    v = -v;

  float t = fabs(v / maxA);

  motor->moveTime[0] = t;
  motor->movePosition[0] = motor->position;
  motor->moveVelocity[0] = v;
  motor->moveAcceleration[0] = (v > 0) ? -maxA : maxA;

  motor->moveTime[1] = 0;
  motor->movePosition[1] = (int32_t)(motor->movePosition[0] + motor->moveVelocity[0] * t + 0.5f * motor->moveAcceleration[0] * t * t);
  motor->moveVelocity[1] = 0;
  motor->moveAcceleration[1] = 0;

  motor->moveAcceleration[0] *= 0.5f;

  motor->destination = motor->movePosition[1];
  
  motor->currentMoveTime = 0;
  motor->currentMove = 0;  
}

boolean isValidMotor(int motorIndex)
{
  return (motorIndex >=0 && motorIndex < MOTOR_COUNT);
}


void processGoPosition(int motorIndex, int32_t pos)
{
  if (motors[motorIndex].position != pos)
  {
    setupMotorMove(motorIndex, pos);
    sendMessage(MSG_MM, motorIndex);
  }
  else
  {
    sendMessage(MSG_MP, motorIndex);
  }
}

/*

Command format

ASCII
[command two bytes]

Version
"hi"
-> "hi 1"

zero motor
"zm 1"
-> "z 1"

move motor
"mm 1 +1111111111

motor position?
mp 1

MOTOR STATUS
"ms"
-> "ms [busy motor count]"

SET PULSE PER SECOND
pr 1 200

STOP MOTOR
sm 1

STOP ALL
sa

*/

/*
 * int processUserMessage(char data)
 *
 * Read user data (from virtual com port), processing one byte at a time.
 * Implemented with a state machine to reduce memory overhead.
 *
 * Returns command code for completed command.
 */
byte processUserMessage(char data)
{
  byte cmd = CMD_NONE;

  switch (msgState)
  {
  case MSG_STATE_START:
    if (data != '\r' && data != '\n')
    {
      msgState = MSG_STATE_CMD;
      msgNumberSign = 1;
      userCmd.command = CMD_NONE;
      userCmd.argCount = 0;
      userCmd.args[0] = 0;
    }
    break;

  case MSG_STATE_CMD:
    if (lastUserData == 'h' && data == 'i')
    {
      userCmd.command = CMD_HI;
      msgState = MSG_STATE_DONE;
    }
    else if (lastUserData == 'm' && data == 's')
    {
      userCmd.command = CMD_MS;
      msgState = MSG_STATE_DONE;
    }
    else if (lastUserData == 's' && data == 'a')
    {
      userCmd.command = CMD_SA;
      msgState = MSG_STATE_DONE;
    }
    else if (lastUserData == 'm' && data == 'm')
    {
      userCmd.command = CMD_MM;
      msgState = MSG_STATE_DATA;
    }
    else if (lastUserData == 'n' && data == 'p')
    {
      userCmd.command = CMD_NP;
      msgState = MSG_STATE_DATA;
    }
    else if (lastUserData == 'm' && data == 'p')
    {
      userCmd.command = CMD_MP;
      msgState = MSG_STATE_DATA;
    }
    else if (lastUserData == 'z' && data == 'm')
    {
      userCmd.command = CMD_ZM;
      msgState = MSG_STATE_DATA;
    }
    else if (lastUserData == 's' && data == 'm')
    {
      userCmd.command = CMD_SM;
      msgState = MSG_STATE_DATA;
    }
    else if (lastUserData == 'p' && data == 'r')
    {
      userCmd.command = CMD_PR;
      msgState = MSG_STATE_DATA;
    }
    else if (lastUserData == 'b' && data == 'f')
    {
      userCmd.command = CMD_BF;
      msgState = MSG_STATE_DATA;
    }
    else if (lastUserData == 'g' && data == 'o')
    {
      userCmd.command = CMD_GO;
      msgState = MSG_STATE_DONE;
    }
    else if (lastUserData == 'j' && data == 'm') // jm [motor] [%speed]
    {
      userCmd.command = CMD_JM;
      msgState = MSG_STATE_DATA;
    }
    else if (lastUserData == 'i' && data == 'm') // im [motor] [%speed]
    {
      userCmd.command = CMD_IM;
      msgState = MSG_STATE_DATA;
    }
    else
    {
      // error msg? unknown command?
      msgState = MSG_STATE_START;
    }
    break;

  case MSG_STATE_DATA:
    if (((data >= '0' && data <= '9') || data == '-') && lastUserData == ' ')
    {
      userCmd.argCount++;
      if (userCmd.argCount >= USER_CMD_ARGS)
      {
        SERIAL_DEVICE.print("error: too many args\r\n");
        msgState = MSG_STATE_ERR;
      }
      else
      {
        userCmd.args[userCmd.argCount - 1] = 0;
        if (data == '-')
        {
          msgNumberSign = -1;
        }
        else
        {
          msgNumberSign = 1;
          userCmd.args[userCmd.argCount - 1] = (data - '0');
        }
      }
    }
    else if (data >= '0' && data <= '9')
    {
      userCmd.args[userCmd.argCount - 1] = userCmd.args[userCmd.argCount - 1] * 10 + (data - '0');
    }
    else if (data == ' ' || data == '\r')
    {
      if (lastUserData  >= '0' && lastUserData <= '9')
      {
        if (userCmd.argCount > 0)
          userCmd.args[userCmd.argCount - 1] *= msgNumberSign;
      }
      if (data == '\r')
      {
        msgState = MSG_STATE_DONE;
      }
    }
    break;


  case MSG_STATE_ERR:
    userCmd.command = CMD_NONE;
    msgState = MSG_STATE_DONE;
    break;

  case MSG_STATE_DONE:
    // wait for newline, then reset
    if (data == '\n' && lastUserData == '\r')
    {
      cmd = userCmd.command;
      msgState = MSG_STATE_START;
      lastUserData = 0;
    }
    break;

  default: // unknown state -> revert to begin
    msgState = MSG_STATE_START;
    lastUserData = 0;
  }

  lastUserData = data;

  return cmd;
}

void processSerialCommand()
{
  byte avail = SERIAL_DEVICE.available();
  byte motor;
  int m;

  for (int i = 0; i < avail; i++)
  {
    int cmd = processUserMessage(SERIAL_DEVICE.read());
    
    if (cmd != CMD_NONE)
    {
      boolean parseError = false;

      motor = userCmd.args[0] - 1;
      
      switch (cmd)
      {
        case CMD_HI:
          sendMessage(MSG_HI, 0);
          break;
        
        case CMD_ZM:
          parseError = (userCmd.argCount != 1 || !isValidMotor(motor));
          if (!parseError)
          {
            motors[motor].position = 0;
            setupMotorMove(motor, 0);
            processGoPosition(motor, 0);
            bitSet(sendPosition, motor);
          }
          break;

        case CMD_MM:
          parseError = (userCmd.argCount != 2 || !isValidMotor(motor));
          if (!parseError)
          {
            processGoPosition(motor, (int32_t)userCmd.args[1]);
          }
          break;

        case CMD_NP:
          parseError = (userCmd.argCount != 2 || !isValidMotor(motor));
          if (!parseError)
          {
            motors[motor].position = userCmd.args[1];
            sendMessage(MSG_MP, motor);
          }
          break;


        case CMD_MP:
          parseError = (userCmd.argCount != 1 || !isValidMotor(motor));
          if (!parseError)
          {
            sendMessage(MSG_MP, motor);
          }
          break;

        case CMD_MS:
          parseError = (userCmd.argCount != 0);
          if (!parseError)
          {
            sendMessage(MSG_MS, 0);
          }
          break;

        case CMD_SM:
          parseError = (userCmd.argCount != 1 || !isValidMotor(motor));
          if (!parseError)
          {
            stopMotor(motor);
            sendMessage(MSG_SM, motor);
            sendMessage(MSG_MP, motor);
          }
          break;

        case CMD_SA:
          parseError = (userCmd.argCount != 0);
          if (!parseError)
          {
            hardStop();
            sendMessage(MSG_SA, 0);
          }
          break;

        case CMD_PR:
          parseError = (userCmd.argCount != 2 || !isValidMotor(motor));
          if (!parseError)
          {
            setPulsesPerSecond(motor, (uint16_t)userCmd.args[1]);
            sendMessage(MSG_PR, motor);
          }
          break;

        case CMD_BF:
          parseError = motorMoving || userCmd.argCount < 5 || ((userCmd.argCount - 2) % 4) != 0;
          if (!parseError)
          {
            goMoDelayTime = 500;
            
            int motorCount = (userCmd.argCount - 2) / 4;
            
            for (m = 0; m < MOTOR_COUNT; m++)
            {
              motors[m].gomoMoveTime[0] = 0.0f;
            }
            
            for (m = 0; m < motorCount; m++)
            {
              int offset = 2 + m * 4;
              motor = userCmd.args[offset] - 1;
              if (!isValidMotor(motor))
              {
                parseError = true;
                break;
              }
              setupBlur(motor, userCmd.args[0], userCmd.args[1], userCmd.args[offset + 1], userCmd.args[offset + 2], userCmd.args[offset + 3]);
            }
            goMoReady = true;
            sendMessage(MSG_BF, 0);

          }
          break;

        case CMD_GO:
          parseError = motorMoving || (userCmd.argCount > 0) || !goMoReady;
          if (!parseError)
          {
            for (m = 0; m < MOTOR_COUNT; m++)
            {
               if (motors[m].gomoMoveTime[0] != 0)
               {
                 int j;
                 for (j = 0; j < P2P_MOVE_COUNT; j++)
                 {
                     motors[m].moveTime[j] = motors[m].gomoMoveTime[j];
                     motors[m].movePosition[j] = motors[m].gomoMovePosition[j];
                     motors[m].moveVelocity[j] = motors[m].gomoMoveVelocity[j];
                     motors[m].moveAcceleration[j] = motors[m].gomoMoveAcceleration[j];
                 }
                 motors[m].destination = motors[m].gomoMovePosition[4]; // TODO change this!
                 motors[m].currentMove = 0;
                 bitSet(motorMoving, m);
               }
            }
            updateMotorVelocities();
            noInterrupts();
            velocityUpdateCounter = VELOCITY_UPDATE_RATE - 1;
            interrupts();
          }
          break;
          
        case CMD_JM:
          parseError = (userCmd.argCount != 2 || !isValidMotor(motor));
          if (!parseError)
          {
            int32_t destination = 0;
            if (jogMotor(motor, userCmd.args[1], &destination))
            {
              if (!bitRead(motorMoving, motor) || destination != motors[motor].destination)
              {
                setupMotorMove(motor, destination);
              }
            }
            sendMessage(MSG_JM, motor);
          }
          break;

        case CMD_IM:
          parseError = (userCmd.argCount != 2 || !isValidMotor(motor));
          if (!parseError)
          {
            inchMotor(motor, userCmd.args[1]);
            sendMessage(MSG_IM, motor);
          }
          break;
          
        default:
          parseError = true;
          break;
      }
      
      if (parseError)
      {
        SERIAL_DEVICE.print("parse error\r\n");
      }
    }
  }
}


/*
 *
 * Serial transmission.
 *
 */
void sendMessage(byte msg, byte motorIndex)
{
#if (BOARD == ARDUINO) || (BOARD == ARDUINOMEGA)

  int i = (unsigned int)(txMsgBuffer.head + 1) % TX_MSG_BUF_SIZE;

  if (i != txMsgBuffer.tail)
  {
    txMsgBuffer.buffer[txMsgBuffer.head].msg = msg;
    txMsgBuffer.buffer[txMsgBuffer.head].motor = motorIndex;
    txMsgBuffer.head = i;
    
    if (!*txBufPtr)
      nextMessage();
  }

#else
  int i;
  
  switch (msg)
  {
    case MSG_HI:
      SERIAL_DEVICE.print("hi ");
      SERIAL_DEVICE.print(DFMOCO_VERSION);
      SERIAL_DEVICE.print(" ");
      SERIAL_DEVICE.print(MOTOR_COUNT);
      SERIAL_DEVICE.print(" ");
      SERIAL_DEVICE.print(DFMOCO_VERSION_STRING);
      SERIAL_DEVICE.print("\r\n");
      break;
    case MSG_MM:
      SERIAL_DEVICE.print("mm ");
      SERIAL_DEVICE.print(motorIndex + 1);
      SERIAL_DEVICE.print(" ");
      SERIAL_DEVICE.print(motors[motorIndex].destination);
      SERIAL_DEVICE.print("\r\n");
      break;
    case MSG_MP:
      SERIAL_DEVICE.print("mp ");
      SERIAL_DEVICE.print(motorIndex + 1);
      SERIAL_DEVICE.print(" ");
      SERIAL_DEVICE.print(motors[motorIndex].position);
      SERIAL_DEVICE.print("\r\n");
      break;
    case MSG_MS:
      SERIAL_DEVICE.print("ms ");
      for (i = 0; i < MOTOR_COUNT; i++)
        SERIAL_DEVICE.print(bitRead(motorMoving, i) ? '1' : '0');
      SERIAL_DEVICE.print("\r\n");
      break;
    case MSG_PR:
      SERIAL_DEVICE.print("pr ");
      SERIAL_DEVICE.print(motorIndex + 1);
      SERIAL_DEVICE.print(" ");
      SERIAL_DEVICE.print((uint16_t)motors[motorIndex].maxVelocity);
      SERIAL_DEVICE.print("\r\n");
      break;
    case MSG_SM:
      SERIAL_DEVICE.print("sm ");
      SERIAL_DEVICE.print(motorIndex + 1);
      SERIAL_DEVICE.print("\r\n");
      break;
    case MSG_SA:
      SERIAL_DEVICE.print("sa\r\n");
      break;
    case MSG_BF:
      SERIAL_DEVICE.print("bf ");
      SERIAL_DEVICE.print(goMoDelayTime);
      SERIAL_DEVICE.print("\r\n");
    case MSG_JM:
      SERIAL_DEVICE.print("jm ");
      SERIAL_DEVICE.print(motorIndex + 1);
      SERIAL_DEVICE.print("\r\n");
      break;
    case MSG_IM:
      SERIAL_DEVICE.print("im ");
      SERIAL_DEVICE.print(motorIndex + 1);
      SERIAL_DEVICE.print("\r\n");
      break;
  }
#endif
}

#if (BOARD == ARDUINO) || (BOARD == ARDUINOMEGA)
void nextMessage()
{
  char *bufPtr;
  int i;
  
  if ((TX_MSG_BUF_SIZE + txMsgBuffer.head - txMsgBuffer.tail) % TX_MSG_BUF_SIZE)
  {
    byte msg = txMsgBuffer.buffer[txMsgBuffer.tail].msg;
    byte motorIndex = txMsgBuffer.buffer[txMsgBuffer.tail].motor;
    txMsgBuffer.tail = (unsigned int)(txMsgBuffer.tail + 1) % TX_MSG_BUF_SIZE;

    switch (msg)
    {
      case MSG_HI:
        sprintf(txBuf, "hi %d %d %s\r\n", DFMOCO_VERSION, MOTOR_COUNT, DFMOCO_VERSION_STRING);
        break;
      case MSG_MM:
        sprintf(txBuf, "mm %d %ld\r\n", motorIndex + 1, motors[motorIndex].destination);
        break;
      case MSG_MP:
        sprintf(txBuf, "mp %d %ld\r\n", motorIndex + 1, motors[motorIndex].position);
        break;
      case MSG_MS:
        sprintf(txBuf, "ms ");
        bufPtr = txBuf + 3;
        for (i = 0; i < MOTOR_COUNT; i++)
          *bufPtr++ = bitRead(motorMoving, i) ? '1' : '0';
        *bufPtr++ = '\r';
        *bufPtr++ = '\n';
        *bufPtr = 0;
        break;
      case MSG_PR:
        sprintf(txBuf, "pr %d %u\r\n", motorIndex + 1, (uint16_t)motors[motorIndex].maxVelocity);
        break;
      case MSG_SM:
        sprintf(txBuf, "sm %d\r\n", motorIndex + 1);
        break;
      case MSG_SA:
        sprintf(txBuf, "sa\r\n");
        break;
      case MSG_BF:
        sprintf(txBuf, "bf %d\r\n", goMoDelayTime);
        break;
      case MSG_JM:
        sprintf(txBuf, "jm %d\r\n", motorIndex + 1);
        break;
      case MSG_IM:
        sprintf(txBuf, "im %d\r\n", motorIndex + 1);
        break;
    }
    
    txBufPtr = txBuf;
  }
}
#endif

boolean jogMotor(int motorIndex, int32_t target, int32_t * destination)
{
  Motor *motor = &motors[motorIndex];
  // ideally send motor to distance where decel happens after 2 seconds
  float vi = (motor->dir ? 1 : -1) * 20 * motor->nextMotorMoveSpeed / 65.536f;
  
  int dir = (target > motor->position) ? 1 : -1;
  // if switching direction, just stop
  if (motor->nextMotorMoveSpeed && motor->dir * dir < 0)
  {
    stopMotor(motorIndex);
    return false;
  }
  if (target == motor->position)
  {
    return false;
  }
  
  float maxVelocity = motor->maxVelocity;
  float maxAcceleration = motor->maxAcceleration;
  
  
  // given current velocity vi
  // compute distance so that decel starts after 0.5 seconds
  // time to accel
  // time at maxvelocity
  // time to decel
  float accelTime = 0, atMaxVelocityTime = 0;
  if (fabs(vi) < maxVelocity)
  {
    accelTime = (maxVelocity - fabs(vi)) / maxAcceleration;
    if (accelTime < 0.5f)
    {
      atMaxVelocityTime = 0.5f - accelTime;
    }
    else
    {
      accelTime = 0.5f;
    }
  }
  else
  {
    atMaxVelocityTime = 0.5f;
  }
  float maxVelocityReached = fabs(vi) + maxAcceleration * accelTime;

  int32_t delta = fabs(vi) * accelTime + (0.5f * maxAcceleration * accelTime * accelTime);
  delta += atMaxVelocityTime * maxVelocityReached;
  delta += 0.5f * (maxVelocityReached * maxVelocityReached) / maxAcceleration; // = 0.5 * a * t^2 -> t = (v/a)
  
  int32_t dest = motor->position + dir * delta;
  
  // now clamp to target
  if ( (dir == 1 && dest > target) || (dir == -1 && dest < target) )
  {
    dest = target;
  }
  *destination = dest;
  return true;
}

void inchMotor(int motorIndex, int32_t target)
{
  Motor *motor = &motors[motorIndex];
  // ideally send motor to distance where decel happens after 2 seconds
  
  // if switching direction, just stop
  int dir = (target > motor->destination) ? 1 : -1;
  
  if (motor->nextMotorMoveSpeed)// && motor->dir * dir < 0)
  {
    stopMotor(motorIndex);
    return;
  }

  int32_t dest = motor->destination + dir * 2;
  
  // now clamp to target
  if ( (dir == 1 && dest > target) || (dir == -1 && dest < target) )
  {
    dest = target;
  }
  //setupMotorMove(motorIndex, dest);
  
  int i, moveCount;
  moveCount = 0;

  for (i = 0; i < P2P_MOVE_COUNT; i++)
  {
    motor->moveTime[i] = 0;
    motor->moveVelocity[i] = 0;
    motor->moveAcceleration[i] = 0;
  }
  motor->currentMoveTime = 0;
  motor->moveTime[0] = 0.01f;
  motor->movePosition[0] = motor->position;
  motor->movePosition[1] = motor->position + dir * 2;
  motor->currentMove = 0;
 
  motor->destination = dest;

  if ( dest != motor->position )
  {
    bitSet(motorMoving, motorIndex);
  }
}

void calculatePointToPoint(int motorIndex, int32_t destination)
{
  Motor *motor = &motors[motorIndex];
  
  int i, moveCount;
  moveCount = 0;

  for (i = 0; i < P2P_MOVE_COUNT; i++)
  {
    motor->moveTime[i] = 0;
    motor->moveVelocity[i] = 0;
    motor->moveAcceleration[i] = 0;
  }
  motor->currentMoveTime = 0;
  motor->movePosition[0] = motor->position;

  float tmax = motor->maxVelocity / motor->maxAcceleration;
  float dmax = motor->maxVelocity * tmax;
  
  float dist = abs(destination - motor->position);
  int dir = destination > motor->position ? 1 : -1;
  
  if (motor->nextMotorMoveSpeed > 5) // we need to account for existing velocity
  {
    float vi = (motor->dir ? 1 : -1) * 20 * motor->nextMotorMoveSpeed / 65.536f;
    float ti = fabs(vi / motor->maxAcceleration);
    float di = 0.5f * motor->maxAcceleration * ti * ti;
    
    if (vi * dir < 0) // switching directions
    {
      motor->moveTime[moveCount] = ti;
      motor->moveAcceleration[moveCount] = dir * motor->maxAcceleration;
      motor->moveVelocity[moveCount] = vi;
      moveCount++;
      
      dist += di;
    }
    else if (dist < di) // must decelerate and switch directions
    {
      motor->moveTime[moveCount] = ti;
      motor->moveAcceleration[moveCount] = -dir * motor->maxAcceleration;
      motor->moveVelocity[moveCount] = vi;
      moveCount++;

      dist = (di - dist);
      dir = -dir;
    }
    else // further on in same direction
    {
      dist += di;
      motor->movePosition[0] -= dir * di;

      motor->currentMoveTime = ti;
    }
  }

  float t = tmax;
  if (dist <= dmax)
  {
    t = sqrt(dist / motor->maxAcceleration);
  }
    
  motor->moveTime[moveCount] = t;
  motor->moveAcceleration[moveCount] = dir * motor->maxAcceleration;
  
  if (dist > dmax)
  {
    moveCount++;
    dist -= dmax;
    float tconst = dist / motor->maxVelocity;
    motor->moveTime[moveCount] = tconst;
    motor->moveAcceleration[moveCount] = 0;
  }

  moveCount++;
  motor->moveTime[moveCount] = t;
  motor->moveAcceleration[moveCount] = dir * -motor->maxAcceleration;


  for (i = 1; i <= moveCount; i++)
  {
    float t = motor->moveTime[i - 1];
    motor->movePosition[i] = (int32_t)(motor->movePosition[i - 1] + motor->moveVelocity[i - 1] * t + 0.5f * motor->moveAcceleration[i - 1] * t * t);
    motor->moveVelocity[i] = motor->moveVelocity[i - 1] + motor->moveAcceleration[i - 1] * t;
  }
  motor->movePosition[moveCount + 1] = destination;
  for (i = 0; i <= moveCount; i++)
  {
    motor->moveAcceleration[i] *= 0.5f; // pre-multiply here for later position calculation
  }
  motor->currentMove = 0;
  
  return;

}

void setupBlur(int motorIndex, int exposure, int blur, int32_t p0, int32_t p1, int32_t p2)
{
  Motor *motor = &motors[motorIndex];
  int i;
  
  float b = blur / 1000.0f;
  float expTime = exposure / 1000.0f;
  
  p0 = p1 + b * (p0 - p1);
  p2 = p1 + b * (p2 - p1);
  
  float speedFactor = ( (1000.0f / exposure) );

  for (i = 0; i < P2P_MOVE_COUNT; i++)
  {
    motor->gomoMoveTime[i] = 0;
    motor->gomoMoveVelocity[i] = 0;
    motor->gomoMoveAcceleration[i] = 0;
  }
  
  motor->gomoMovePosition[1] = p0;
  motor->gomoMoveTime[1] = expTime * 0.5f;
  motor->gomoMoveVelocity[1] = (float)(p1 - p0) / (expTime * 0.5f);

  motor->gomoMovePosition[2] = p1;
  motor->gomoMoveTime[2] = expTime * 0.5f;
  motor->gomoMoveVelocity[2] = (float)(p2 - p1) / (expTime * 0.5f);

  // v = a*t -> a = v / t
  float accelTime = 1.0f;
  float a = motor->gomoMoveVelocity[1] / accelTime;
  float dp = 0.5f * a * accelTime * accelTime;
  float sp = p0 - dp; // starting position

  motor->gomoMovePosition[0] = sp;
  motor->gomoMoveTime[0] = accelTime;
  motor->gomoMoveAcceleration[0] = 0.5f * a; // pre-multiplied

  a = motor->gomoMoveVelocity[2] / accelTime;
  dp = 0.5f * a * accelTime * accelTime;
  float fp = p2 + dp;

  motor->gomoMovePosition[3] = p2;
  motor->gomoMoveTime[3] = accelTime;
  motor->gomoMoveVelocity[3] = motor->gomoMoveVelocity[2];
  motor->gomoMoveAcceleration[3] = -0.5f * a; // pre-multiplied

  motor->gomoMovePosition[4] = fp;

  setupMotorMove(motorIndex, sp);
}

float calculateVelocityMotor(int motorIndex, float local_time, float local_ramp)
{
  Motor *motor = &motors[motorIndex];
  float new_time=local_time;
  //set

  motor->moveMaxVelocity = abs(motor->destination-motor->position)/(local_time*(1.0-local_ramp));
  //enforce the max velocity
  if  (motor->moveMaxVelocity>motor->jogMaxVelocity) // we need to figure out new times 
  {
   new_time = abs(motor->destination-motor->position)/(motor->jogMaxVelocity*(1.0-local_ramp));
   motor->moveMaxVelocity=motor->jogMaxVelocity;
  }
  
  
  //we can do anything for acceleration
  motor->moveMaxAcceleration=motor->moveMaxVelocity /(local_ramp*local_time);
  //return velocitytemp;
  if (DEBUG_MOTOR) Serial.print("moveMaxVelocity:");Serial.println(motor->moveMaxVelocity);
  if (DEBUG_MOTOR) Serial.print("moveMaxAcceleration:");Serial.println(motor->moveMaxAcceleration);
  return new_time; //returns the time
}

void calculateVelocityMotorold(int motorIndex, float local_time, float local_ramp)
{
  Motor *motor = &motors[motorIndex];
  //set

  motor->moveMaxVelocity = abs(motor->destination-motor->position)/(local_time*(1.0-local_ramp));
  motor->moveMaxAcceleration=motor->moveMaxVelocity /(local_ramp*local_time);
  //return velocitytemp;
  if (DEBUG_MOTOR) Serial.print("moveMaxVelocity:");Serial.println(motor->moveMaxVelocity);
  if (DEBUG_MOTOR) Serial.print("moveMaxAcceleration:");Serial.println(motor->moveMaxAcceleration);
}





void synched3PtMove_max(float xtarget, float ytarget, float ztarget) //
{
    //Clean up positions so we don't drift
    motors[0].position = long(current_steps.x);
    motors[1].position = long(current_steps.y);
    motors[2].position = long(current_steps.z);
   
    motors[0].destination = xtarget;
    motors[1].destination = ytarget;
    motors[2].destination = ztarget;
 
    //Calculate the fastest move times based on max speeds and accelerations, we will recalc later after figuring out dominant axix (limiting axis)
    calculatePointToPoint_jog(0,xtarget);
    calculatePointToPoint_jog(1,ytarget);
    calculatePointToPoint_jog(2,ztarget); 
    
    for (int mot = 0; mot < 3; mot++)
    {
      DisplayMove(mot);
    }

    //Figure out what the longest time needed for each of the axis at maxspeed
    
    float MotorTotalMoveTime[3]={0.0,0.0,0.0};

    for (int mot = 0; mot < 3; mot++)
      {  
        for (int seg = 0; seg < 3; seg++) //segments
         {
           MotorTotalMoveTime[mot]+=motors[mot].moveTime[seg];
         }
       if(DEBUG_MOTOR) Serial.print("Motor");Serial.print(mot);Serial.print(" TotalMaxMoveTime");Serial.println(MotorTotalMoveTime[mot]);

         
      }


  //Determine dominant Axis  - start with Pan or motor 0
    float LongestMoveTime=MotorTotalMoveTime[0];
    int DominantMotor = 0;

  
  if(MotorTotalMoveTime[1]>MotorTotalMoveTime[0]) 
  {
     LongestMoveTime=MotorTotalMoveTime[1];
     DominantMotor=1;
  }
     
  if(MotorTotalMoveTime[2]>LongestMoveTime) 
  {
     LongestMoveTime=MotorTotalMoveTime[2];
     DominantMotor=2;
  }
  //End of Determine dominant Axix  
  //create branch to eiether jog back max speed, or use local time if it is longer..
  if (DEBUG_MOTOR) Serial.print("LongestMoveTime");Serial.println(LongestMoveTime);
  if (DEBUG_MOTOR) Serial.print("DominantMotor");Serial.println(DominantMotor);
  
  //For dominant axis, grab the key times for keyframing the other axis
  
//calculateVelocityMotor(DominantMotor, local_time, local_ramp); //this sets the velocity & accel for a movecalc
//calculatePointToPoint_move(DominantMotor);
//DisplayMove(DominantMotor);
float quickest_ramp = motors[DominantMotor].moveTime[0]/LongestMoveTime;


    for (int mot = 0; mot < 3; mot++)
    {
      calculateVelocityMotor(mot, LongestMoveTime, quickest_ramp); //this sets the velocity & accel for a movecalc
      calculatePointToPoint_move(mot);
      DisplayMove(mot);
      if (motors[mot].destination!=motors[mot].position) bitSet(motorMoving, mot);
      else bitClear(motorMoving, mot);
    }

if(DEBUG_MOTOR) Serial.print("motorMoving byte="); Serial.println(motorMoving);    

   
}

void synched3AxisMove_timed(float xtarget, float ytarget, float ztarget, float local_time, float local_ramp) //
{
    //Clean up positions so we don't drift
    motors[0].position = long(current_steps.x);
    motors[1].position = long(current_steps.y);
    motors[2].position = long(current_steps.z);
   
    motors[0].destination = xtarget;
    motors[1].destination = ytarget;
    motors[2].destination = ztarget;
 
    //Calculate the timing for the total move with max velocities
    calculatePointToPoint_jog(0,xtarget);
    calculatePointToPoint_jog(1,ytarget);
    calculatePointToPoint_jog(2,ztarget); 
    
    for (int mot = 0; mot < 3; mot++)
    {
      DisplayMove(mot);
    }

    //Figure out what the longest time needed for each of the axis at maxspeed
    
    float MotorTotalMoveTime[3]={0.0,0.0,0.0};

    for (int mot = 0; mot < 3; mot++)
      {  
        for (int seg = 0; seg < 3; seg++) //segments
         {
           MotorTotalMoveTime[mot]+=motors[mot].moveTime[seg];
         }
       if(DEBUG_MOTOR) Serial.print("Motor");Serial.print(mot);Serial.print(" TotalMaxMoveTime");Serial.println(MotorTotalMoveTime[mot]);

         
      }


  //Determine dominant Axis  - start with Pan or motor 0
    float LongestMoveTime=MotorTotalMoveTime[0];
    int DominantMotor = 0;

  
  if(MotorTotalMoveTime[1]>MotorTotalMoveTime[0]) 
  {
     LongestMoveTime=MotorTotalMoveTime[1];
     DominantMotor=1;
  }
     
  if(MotorTotalMoveTime[2]>LongestMoveTime) 
  {
     LongestMoveTime=MotorTotalMoveTime[2];
     DominantMotor=2;
  }
  //End of Determine dominant Axix  
  //create branch to eiether jog back max speed, or use local time if it is longer..
  if (DEBUG_MOTOR) Serial.print("LongestMoveTime");Serial.println(LongestMoveTime);
  if (DEBUG_MOTOR) Serial.print("DominantMotor");Serial.println(DominantMotor);
  
  //For dominant axis, grab the key times for keyframing the other axis
  
//calculateVelocityMotor(DominantMotor, local_time, local_ramp); //this sets the velocity & accel for a movecalc
//calculatePointToPoint_move(DominantMotor);
//DisplayMove(DominantMotor);
float quickest_ramp = motors[DominantMotor].moveTime[0]/LongestMoveTime;

//Check our velocity calc

float limited_motor_move_time_max=0.0;
    maxVelLimit=false;
    for (int mot = 0; mot < 3; mot++)
    {
      float limited_motor_move_time=calculateVelocityMotor(mot, local_time, local_ramp);
      if (limited_motor_move_time>limited_motor_move_time_max) limited_motor_move_time_max=limited_motor_move_time;
      calculatePointToPoint_move(mot);
      DisplayMove(mot);
      if (motors[mot].destination!=motors[mot].position) bitSet(motorMoving, mot);
      else bitClear(motorMoving, mot);
    }
    
if (limited_motor_move_time_max>local_time)  {  //run the routine again with new max time if the real calculated values hit limits.

    maxVelLimit=true;
    for (int mot = 0; mot < 3; mot++)
    {
      calculateVelocityMotor(mot, limited_motor_move_time_max, local_ramp);
      calculatePointToPoint_move(mot);
      DisplayMove(mot);
      if (motors[mot].destination!=motors[mot].position) bitSet(motorMoving, mot);
      else bitClear(motorMoving, mot);
    }

}
    

if (DEBUG_MOTOR) Serial.print("motorMoving byte="); Serial.println(motorMoving);    

   
}


void calculatePointToPoint_move(int motorIndex)
{
  Motor *motor = &motors[motorIndex];
  
  int i, moveCount;
  moveCount = 0;

  for (i = 0; i < P2P_MOVE_COUNT; i++)
  {
    motor->moveTime[i] = 0;
    motor->moveVelocity[i] = 0;
    motor->moveAcceleration[i] = 0;
  }
  motor->currentMoveTime = 0;
  motor->movePosition[0] = motor->position;

  float tmax = motor->moveMaxVelocity / motor->moveMaxAcceleration;
  float dmax = motor->moveMaxVelocity * tmax;
  
  float dist = abs(motor->destination - motor->position);
  int dir = motor->destination > motor->position ? 1 : -1;
  
  /*
  if (motor->nextMotorMoveSpeed > 5) // we need to account for existing velocity
  {
    float vi = (motor->dir ? 1 : -1) * 20 * motor->nextMotorMoveSpeed / 65.536f;
    float ti = fabs(vi / motor->moveMaxAcceleration);
    float di = 0.5f * motor->moveMaxAcceleration * ti * ti;
    
    if (vi * dir < 0) // switching directions
    {
      motor->moveTime[moveCount] = ti;
      motor->moveAcceleration[moveCount] = dir * motor->moveMaxAcceleration;
      motor->moveVelocity[moveCount] = vi;
      moveCount++;
      
      dist += di;
    }
    else if (dist < di) // must decelerate and switch directions
    {
      motor->moveTime[moveCount] = ti;
      motor->moveAcceleration[moveCount] = -dir * motor->moveMaxAcceleration;
      motor->moveVelocity[moveCount] = vi;
      moveCount++;

      dist = (di - dist);
      dir = -dir;
    }
    else // further on in same direction
    {
      dist += di;
      motor->movePosition[0] -= dir * di;

      motor->currentMoveTime = ti;
    }
  }
  */
  
  
  float t = tmax;
  if (dist <= dmax)
  {
    t = sqrt(dist / motor->moveMaxAcceleration);
  }
    
  motor->moveTime[moveCount] = t;
  motor->moveAcceleration[moveCount] = dir * motor->moveMaxAcceleration;
  
  if (dist > dmax)
  {
    moveCount++;
    dist -= dmax;
    float tconst = dist / motor->moveMaxVelocity;
    motor->moveTime[moveCount] = tconst;
    motor->moveAcceleration[moveCount] = 0;
  }

  moveCount++;
  motor->moveTime[moveCount] = t;
  motor->moveAcceleration[moveCount] = dir * -motor->moveMaxAcceleration;


  for (i = 1; i <= moveCount; i++)
  {
    float t = motor->moveTime[i - 1];
    motor->movePosition[i] = (int32_t)(motor->movePosition[i - 1] + motor->moveVelocity[i - 1] * t + 0.5f * motor->moveAcceleration[i - 1] * t * t);
    motor->moveVelocity[i] = motor->moveVelocity[i - 1] + motor->moveAcceleration[i - 1] * t;
  }
  motor->movePosition[moveCount + 1] = motor->destination;
  for (i = 0; i <= moveCount; i++)
  {
    motor->moveAcceleration[i] *= 0.5f; // pre-multiply here for later position calculation
  }
  motor->currentMove = 0;
  
  return;

}

void calculatePointToPoint_jog(int motorIndex, int32_t destination)
{
  Motor *motor = &motors[motorIndex];
  
  int i, moveCount;
  moveCount = 0;

  for (i = 0; i < P2P_MOVE_COUNT; i++)
  {
    motor->moveTime[i] = 0;
    motor->moveVelocity[i] = 0;
    motor->moveAcceleration[i] = 0;
  }
  motor->currentMoveTime = 0;
  motor->movePosition[0] = motor->position;

  float tmax = motor->jogMaxVelocity / motor->jogMaxAcceleration;
  float dmax = motor->jogMaxVelocity * tmax;
  
  float dist = abs(destination - motor->position);
  int dir = destination > motor->position ? 1 : -1;
 
 /* 
  if (motor->nextMotorMoveSpeed > 5) // we need to account for existing velocity
  {
    float vi = (motor->dir ? 1 : -1) * 20 * motor->nextMotorMoveSpeed / 65.536f;
    float ti = fabs(vi / motor->jogMaxAcceleration);
    float di = 0.5f * motor->jogMaxAcceleration * ti * ti;
    
    if (vi * dir < 0) // switching directions
    {
      motor->moveTime[moveCount] = ti;
      motor->moveAcceleration[moveCount] = dir * motor->jogMaxAcceleration;
      motor->moveVelocity[moveCount] = vi;
      moveCount++;
      
      dist += di;
    }
    else if (dist < di) // must decelerate and switch directions
    {
      motor->moveTime[moveCount] = ti;
      motor->moveAcceleration[moveCount] = -dir * motor->jogMaxAcceleration;
      motor->moveVelocity[moveCount] = vi;
      moveCount++;

      dist = (di - dist);
      dir = -dir;
    }
    else // further on in same direction
    {
      dist += di;
      motor->movePosition[0] -= dir * di;

      motor->currentMoveTime = ti;
    }
  }
  */
   
   
  float t = tmax;
  if (dist <= dmax)
  {
    t = sqrt(dist / motor->jogMaxAcceleration);
  }
    
  motor->moveTime[moveCount] = t;
  motor->moveAcceleration[moveCount] = dir * motor->jogMaxAcceleration;
  
  if (dist > dmax)
  {
    moveCount++;
    dist -= dmax;
    float tconst = dist / motor->jogMaxVelocity;
    motor->moveTime[moveCount] = tconst;
    motor->moveAcceleration[moveCount] = 0;
  }

  moveCount++;
  motor->moveTime[moveCount] = t;
  motor->moveAcceleration[moveCount] = dir * -motor->jogMaxAcceleration;


  for (i = 1; i <= moveCount; i++)
  {
    float t = motor->moveTime[i - 1];
    motor->movePosition[i] = (int32_t)(motor->movePosition[i - 1] + motor->moveVelocity[i - 1] * t + 0.5f * motor->moveAcceleration[i - 1] * t * t);
    motor->moveVelocity[i] = motor->moveVelocity[i - 1] + motor->moveAcceleration[i - 1] * t;
  }
  motor->movePosition[moveCount + 1] = destination;
  for (i = 0; i <= moveCount; i++)
  {
    motor->moveAcceleration[i] *= 0.5f; // pre-multiply here for later position calculation
  }
  motor->currentMove = 0;
  
  return;

}







