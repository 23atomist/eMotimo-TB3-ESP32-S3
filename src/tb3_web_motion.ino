/*
  Keep-critical web-motion/track functions, extracted verbatim out of the
  doomed on-device-menu files (_TB3_LCD_Buttons.ino, TB3_InShootMenu.ino)
  ahead of their deletion. No behavior change: bodies, signatures, and the
  lcd calls / draw() calls inside them are unchanged from their origin.
*/

#if defined(ESP32)

// ---------------------------------------------------------------------------
// Track (Web) - the one screen where the layer-3 host servo can drive the rig.
//
// Web jog only produces motion where three things run in the SAME input loop:
//   DFSetup()                - motion params + the 40kHz step ISR
//   NunChuckQuerywithEC()    - pumps tb3_web_poll(), which lands the web
//                              joystick on the virtual gamepad AND drains
//                              pending goto/stop requests
//   updateMotorVelocities2() - gamepad -> motor velocity (the cubic curve)
// Everywhere else they coincide only on a program's point-setting screens,
// where a stray C press advances program state out from under a live track.
// This is that same input+velocity loop with the program state taken out: the
// while loop below never reads or writes progstep/progtype and has no
// progstep_forward/backward path, so no button press can advance anything. The
// only writes are the entry park and the exit progstep_goto(0), both outside
// the loop and neither driven by input.
// ---------------------------------------------------------------------------
void Web_Track_Mode()
{
#if defined(ESP32)
    char ipline[17];
    uint32_t ip_last;

    lcd.empty();
    lcd.bright(6);
    draw(91,1,3);//lcd.at(1,3,"Track (Web)");
    tb3_track_ip_line(ipline);        // where the operator points the daemon
    lcd.at(2,1,ipline);
    ip_last=millis();

    // Park progstep off every zone the LCD rotator and the web program picker
    // recognise (see WEBTRACK_PROGSTEP). Set once here, restored once on exit;
    // the loop itself never touches it.
    progstep=WEBTRACK_PROGSTEP;

    joy_x_axis=0;
    joy_y_axis=0;
    accel_x_axis=0;
    CZ_Button_Read_Count=0;           // stale taps must not count toward the exit hold

    DFSetup();                        //setup the ISR + motion params
    NunChuckQuerywithEC(); //  Use this to clear out any button registry from the last step

    boolean exit_track=false;
    while (!exit_track)
    {
        // Re-assert the step ISR every pass. tb3_goto_execute() is dispatched
        // from INSIDE NunChuckQuerywithEC() (via tb3_web_poll()) and ends with
        // an unconditional stopISR1(). onTimer() is the only writer that clears
        // nextMoveLoaded, so a goto that leaves the timer stopped latches the
        // gate below closed forever - no jog, and no further web input at all.
        // startISR1() early-returns when the timer already runs, so this is one
        // volatile read per pass.
        //
        // ...except while an OTA is actually flashing. tb3_ota_prepare() runs
        // stopISR1() from the AsyncTCP task to get the 40kHz ISR off the bus
        // before Update.write(), and tb3_ota_safe_to_flash() reads true while
        // this mode sits idle - so without this gate we would restart the ISR
        // underneath the flash writes within one pass.
        //
        // The test is "not RUNNING", NOT "== TB3_OTA_IDLE": TB3_OTA_ERROR is
        // sticky (nothing clears it until the next upload begins), so gating on
        // IDLE would permanently stop re-asserting the ISR after one failed OTA
        // and latch this mode dead - the exact failure the re-assert prevents.
        // Restarting on ERROR also matches the OTA module itself, which calls
        // tb3_ota_resume() (startISR1) on every failure path.
        if (tb3_ota_state() != TB3_OTA_RUNNING) startISR1();

        if (!nextMoveLoaded)
        {
            NunChuckQuerywithEC();
            axis_button_deadzone();
            updateMotorVelocities2();

            // Deliberate exit only: C+Z held, the same counter/threshold the
            // start-delay screen uses (button_actions_review). Check_Prog()
            // never clears the count on release, so callers must - otherwise 21
            // stray taps over a long session would add up to an exit. Reset it
            // here on any non-hold so only a continuous ~1s hold gets out.
            Check_Prog();
            if (!(c_button && z_button)) CZ_Button_Read_Count=0;
            else if (CZ_Button_Read_Count>20) exit_track=true;

            // STA can join or drop while we sit here; refresh the address, but
            // only on an actual change (an LCD line write costs ~16ms).
            if ((millis()-ip_last)>1000) {
                ip_last=millis();
                char ipnow[17];
                tb3_track_ip_line(ipnow);
                if (strcmp(ipnow,ipline)) { strcpy(ipline,ipnow); lcd.at(2,1,ipline); }
            }
        }
    }

    //this puts input to zero to allow a stop
    joy_x_axis=0.0;
    joy_y_axis=0.0;
    accel_x_axis=0.0;

    // Ramp down through the same velocity engine the jog screens use. It only
    // makes progress while the ISR clears nextMoveLoaded, so the timer stays on
    // until the motors are actually stopped. Bounded like tb3_goto_execute()'s
    // move loop: a decel that never completes must not wedge the rig on exit.
    startISR1();
    uint32_t t0=millis();
    do //run this loop until the motors stop
    {
        if (!nextMoveLoaded) updateMotorVelocities2();
        if ((millis()-t0)>3000) { motorMoving=0; break; }
    } while (motorMoving);

    // Leave the step engine as the menu was entered at cold boot (setupstartISR1
    // arms the timer but leaves it stopped) and as tb3_goto_execute() leaves it.
    // This also lets tb3_ota_health_tick() confirm a pending image, which it
    // defers whenever the timer is left free-running.
    stopISR1();

    // Wait for the buttons to come up before handing control back. The menu
    // dispatches on a HELD c_button (button_actions_choose_program's
    // switch(c_button)) and progtype is still WEBTRACK, so returning with C down
    // re-enters this mode immediately: nothing in the path clears the button -
    // progstep_goto()'s own NunChuckQuerywithEC() clears g_usb_button_c and then
    // tb3_web_poll() re-asserts it while it is still down. The
    // reference jog screens dodge this by exiting on Z alone under case 0: of
    // switch(c_button), i.e. only when C is already up; this mode exits on C+Z,
    // so it has to do the waiting itself.
    //
    // Bounded like the decel loop above, and for the same reason: a stuck stick
    // or a daemon re-posting {"b":"c"} (each press clamped to 2000ms by
    // applyInputCommand) must not wedge the rig here. 3000ms outlasts one
    // full-length web press. The motors are stopped and the ISR is already off
    // by this point, so a timeout still leaves the menu exactly the state it
    // expects - it just costs the operator one bounce, as today.
    uint32_t t_rel=millis();
    do {
        NunChuckQuerywithEC();
        NunChuckjoybuttons();         //also re-arms CZ_Released for the menu
        delay(10);                    //same poll pace Check_Prog() uses on a C+Z pass
    } while ((c_button || z_button) && (millis()-t_rel)<3000);

    CZ_Button_Read_Count=0;
    progstep_goto(0);                 //empties the LCD, first_time=1, back to the menu
#endif
}


// The idle handler for a menu-less firmware. Runs once per loop() pass.
// Non-track: a web servo — re-assert the step ISR (a prior goto ends with
// stopISR1(), and onTimer() is the only writer that clears nextMoveLoaded, so
// without this a completed goto latches jog/web-input dead), then pump the web
// input (NunChuckQuerywithEC drains /api/goto and /api/joy via tb3_web_poll).
// Track: delegate to Web_Track_Mode(), which runs its own inner loop until the
// daemon-selected mode is left. The ISR re-assert is skipped while an OTA is
// actually flashing (tb3_ota_prepare stops the ISR from the AsyncTCP task).
void tb3_idle_dispatch() {
#if defined(ESP32)
  // Web/MCP idle handler with auto engage/release. Boot leaves MOTOR_EN HIGH
  // (disabled). On activity -- a jog stick deflection, live motion, or a
  // blocking /api/goto self-enabling the motors -- the drivers are engaged
  // (DFSetup: enable_PT/enable_AUX + motion-param init, like Web_Track_Mode's
  // entry) and the target position is held. After IDLE_RELEASE_MS of no
  // activity the drivers are released, so the rig frees up and cools at idle
  // instead of holding torque forever. g_motors_enabled is the TRUE driver
  // state (a blocking goto enables them without the dispatcher's knowledge).
  // WEBTRACK delegates to Web_Track_Mode, which manages its own motors.
  static bool s_ever_active = false;
  static bool s_prev_en = false;
  static uint32_t s_last_active = 0;
  const uint32_t IDLE_RELEASE_MS = 15000;   // release the drivers after 15s idle

  if (progtype == WEBTRACK) { Web_Track_Mode(); return; }
  if (tb3_ota_state() != TB3_OTA_RUNNING) startISR1();

  if (!nextMoveLoaded) {
    NunChuckQuerywithEC();
    axis_button_deadzone();

    uint32_t now = millis();
    // A blocking goto (run inside NunChuckQuerywithEC via tb3_web_poll) enables
    // the motors itself; catch that 0->1 edge as activity so its target is held.
    if (g_motors_enabled && !s_prev_en) { s_last_active = now; s_ever_active = true; }
    if (joy_x_axis != 0.0f || joy_y_axis != 0.0f || accel_x_axis != 0.0f || motorMoving) {
      s_last_active = now; s_ever_active = true;
    }

    bool wantEnabled = s_ever_active && ((uint32_t)(now - s_last_active) < IDLE_RELEASE_MS);
    if (wantEnabled) {
      if (!g_motors_enabled) DFSetup();      // engage: enable drivers + init motion params
      updateMotorVelocities2();
    } else if (g_motors_enabled) {
      disable_PT(); disable_AUX();            // idle: release the drivers (free + cool)
    }
    s_prev_en = g_motors_enabled;             // after our own enable/disable, so it isn't re-seen as a goto edge
  }
#endif
}


void progstep_forward()
{
first_time=1;
progstep_forward_dir=true;
progstep++;
delay(100);
NunChuckQuerywithEC(); //  Use this to clear out any button registry from the last step
}

void progstep_backward()
{
first_time=1;
progstep_forward_dir=false;
if (progstep>0) progstep--;
else progstep=0;
delay(100);
NunChuckQuerywithEC(); //  Use this to clear out any button registry from the last step
}

void progstep_goto(unsigned int prgstp)
{
  lcd.empty();
  first_time=1;
  progstep=prgstp;
  delay(100);
  NunChuckQuerywithEC(); //  Use this to clear out any button registry from the last step
}


void Check_Prog()  //this is a routine for the button presses in the program
{

            switch (c_button) // looking for c button press 
            {
              case 1: //  //c on
                  C_Button_Read_Count++; //c button on
				  if ((millis()-input_last_tm)>2000) C_Button_Read_Count=0;
				  input_last_tm=millis();
				  
				  switch (z_button) //z on
                  {
                    case 1: // Z button on as well
                         CZ_Button_Read_Count++;
						 Z_Button_Read_Count++;
                         delay(10);
                         if ((millis()-input_last_tm)>2000) {
							 CZ_Button_Read_Count=0;
							 Z_Button_Read_Count=0;
							 input_last_tm=millis();
						 }
                         break;
                    default:
                        
                        break;    
                  }
   
              case 0:
                  switch (z_button) //this would send us back to step 5
                {
                  case 1: // button on
                       Z_Button_Read_Count++; //z button only on
					    if ((millis()-input_last_tm)>2000) {
						   Z_Button_Read_Count=0;
						   input_last_tm=millis();
						}
					   break;
                  case 0: // button off
                       break;
                  default:
                      
                      break;    
                }
              default:
                  
                  break;    
           }    
}

#endif // ESP32
