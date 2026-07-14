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


unsigned long motor_steps_pov[2][2];  // 2 total points.  Used for Pano Calcs and other hard targets
unsigned long Pan_AOV_steps;
unsigned long Tilt_AOV_steps;
unsigned long olpercentage=20;
unsigned long steps_per_shot_max_x;
unsigned long steps_per_shot_max_y;
unsigned long total_shots_x; //calulated value for to divide up scene evenly
unsigned long total_shots_y; //calulated value for to divide up scene evenly
unsigned long total_pano_shots; //rows x columns for display
long step_per_pano_shot_x;
long step_per_pano_shot_y;


//PORTRAITPANO Method Variables -  3x3, 7x3, 5x5 top third, 7x5 top third

int PanoArrayType=1; // 
int OnionArray9 [10][2] =  {{0,0},{0,-1},{-1,-1},{-1,0},{-1,1},{0,1},{1,1},{1,0},{1,-1},{0,0}};
                    
int OnionArray25 [26][2] = {{0,0},{0,-1},{-1,-1},{-1,0},{-1,1},{0,1},{1,1},{1,0},{1,-1},{0,-2},
						  {-1,-2},{-2,-2},{-2,-1},{-2,-0},{-2,1},{-2,2},{-1,2},{0,2},{1,2},{2,2},
						  {2,1},{2,0},{2,-1},{2,-2},{1,-2},{0,0}};							  
  
int SevenByThree[22][2]=  {{0,0},{0,-1},{-1,-1},{-1,0},{-1,1},{0,1},{1,1},{1,0},{1,-1},{2,-1},
                          {2,0},{2,1},{3,1},{3,0},{3,-1},{-2,-1},{-2,0},{-2,1},{-3,1},{-3,0},
                          {-3,-1},{0,0}};
int NineByFive_1[46][2]=  {{0,0},{0,-1},{-1,-1},{-1,0},{-1,1},{0,1},{1,1},{1,0},{1,-1},{2,-1},
                          {2,0},{2,1},{3,1},{3,0},{3,-1},{4,-1},{4,0},{4,1},{4,2},{3,2},{2,2},
                          {1,2},{0,2},{-1,2},{-2,2},{-2,1},{-2,0},{-2,-1},{-3,-1},{-3,0},{-3,1},
                          {-3,2},{-4,2},{-4,1},{-4,0},{-4,-1},{-4,-2},{-3,-2},{-2,-2},{-1,-2},
                          {0,-2},{1,-2},{2,-2},{3,-2},{4,-2},{0,0}};
int NineByFive_2[46][2]=  {{0,0},{0,-1},{-1,-1},{-1,0},{-1,1},{0,1},{1,1},{1,0},{1,-1},{2,-1},
                          {2,0},{2,1},{2,2},{1,2},{0,2},{-1,2},{-2,2},{-2,1},{-2,0},{-2,-1},
                          {-2,-2},{-1,-2},{0,-2},{1,-2},{2,-2},{3,-2},{3,-1},{3,0},{3,1},{3,2},
                          {4,2},{4,1},{4,0},{4,-1},{4,-2},{-3,-2},{-3,-1},{-3,0},{-3,1},{-3,2},
                          {-4,2},{-4,1},{-4,0},{-4,-1},{-4,-2},{0,0}};
int TopThird25 [26][2] =  {{0,0},{0,-1},{0,-2},{-1,-2},{-1,-1},{-1,0},{-1,1},{0,1},{1,1},{1,0},
                          {1,-1},{1,-2},{2,1},{2,0},{2,-1},{2,-2},{2,-3},{1,-3},{0,-3},{-1,-3},
                          {-2,-3},{-2,-2},{-2,-1},{-2,0},{-2,1},{0,0}};
int TopThird7by5 [36][2] ={{0,0},{0,-1},{0,-2},{-1,-2},{-1,-1},{-1,0},{-1,1},{0,1},{1,1},{1,0},
                          {1,-1},{1,-2},{2,-2},{2,-1},{2,0},{2,1},{3,1},{3,0},{3,-1},{3,-2},
                          {3,-3},{2,-3},{1,-3},{0,-3},{-1,-3},{-2,-3},{-2,-2},{-2,-1},{-2,0},{-2,1},
                          {-3,1},{-3,0},{-3,-1},{-3,-2},{-3,-3},{0,0}};



void Set_angle_of_view()
{
        if (first_time==1){
        
            AUX_ON=false; //turn of Auz since only PT  
            lcd.empty();
            //set_position(Pan_AOV_steps, Tilt_AOV_steps, 0.0);           
            draw(75,1,1);//lcd.at(1,1,"Set Angle o'View");
            draw(76,2,2);//lcd.at(2,2,"C-Set, Z-Reset");
            delay(prompt_time);
            lcd.empty();
            
            
            draw(77,1,1);   //lcd.at(1,1,"Pan AOV: ");
            lcd.at(1,11,steps_to_deg_decimal(0));
            draw(78,2,1);   //lcd.at(2,1,"Tilt AOV: ");
            lcd.at(2,11,steps_to_deg_decimal(0));
            first_time=0;
            //delay(prompt_time);
            NunChuckQuerywithEC(); //  Use this to clear out any button registry from the last step
             
             
             //   Velocity Engine update        
            DFSetup(); //setup the ISR
            int32_t *ramValues = (int32_t *)malloc(sizeof(int32_t) * MOTOR_COUNT);
            int32_t *ramNotValues = (int32_t *)malloc(sizeof(int32_t) * MOTOR_COUNT);
        }

       

        
 //Velocity Engine update
      if (!nextMoveLoaded) 
      {
        NunChuckQuerywithEC();
        axis_button_deadzone();
        updateMotorVelocities2();
         
        lcd.at(1,11,steps_to_deg_decimal(abs(current_steps.x)));
        lcd.at(2,11,steps_to_deg_decimal(abs(current_steps.y)));     
        button_actions_move_x(1);
     }        
        
  
}



void Define_Overlap_Percentage()
{
        if (first_time==1){
        
            lcd.empty();
            draw(79,1,2);   //lcd.at(1,2,"   % Overlap");
            draw(3,2,1);//lcd.at(2,1,CZ1);
            //olpercentage=20;
            Display_olpercentage();
            first_time=0;
            delay(prompt_time);
            NunChuckQuerywithEC(); //  Use this to clear out any button registry from the last step
            //motor_steps_pt[2][0];

        }
        
          unsigned int olpercentage_last=olpercentage;
          NunChuckQuerywithEC();
          NunChuckjoybuttons();
          if (olpercentage<20) joy_y_lock_count=0;
          olpercentage += joy_capture3();
          if (olpercentage<=0) {olpercentage=1;}
          if (olpercentage>99) {olpercentage=99;}
          
          if (olpercentage_last!=olpercentage) {
              Display_olpercentage();
          }
          //delay(50);
          button_actions_olpercentage();  //read buttons, look for c button press to set interval
          delay (prompt_delay);
}    

void Display_olpercentage()  {      
  lcd.at(1,2,olpercentage); 
  if (olpercentage <10)  lcd.at(1,3," ");  //clear extra if goes from 3 to 2 or 2 to  1
 // if (olpercentage<100)  lcd.at(1,9," ");  //clear extra if goes from 3 to 2 or 2 to  1
}

void button_actions_olpercentage()  {

            switch (c_button) // looking for c button press 
            {
              case 1: // 
                  //perform all calcs based on Angle of view and percentage overlap
                   Pan_AOV_steps=abs(current_steps.x); //Serial.println(Pan_AOV_steps);
                   Tilt_AOV_steps=abs(current_steps.y); //Serial.println(Tilt_AOV_steps);
                    
                   steps_per_shot_max_x = float((float(1.0)-float(olpercentage/100.0))*float(Pan_AOV_steps)); //Serial.println(steps_per_shot_max_x);
                   steps_per_shot_max_y = float((float(1.0)-float(olpercentage/100.0))*float(Tilt_AOV_steps)); //Serial.println(steps_per_shot_max_y);
                   if (DEBUG_PANO) Serial.print("steps_per_shot_max_x");Serial.println(steps_per_shot_max_x);
                   if (DEBUG_PANO) Serial.print("steps_per_shot_max_y");Serial.println(steps_per_shot_max_y);
                   

                
                   lcd.empty();
                   draw(80,1,3);   //lcd.at(1,3,"Overlap Set");
                   delay(prompt_time);
                   progstep_forward();
                   break;
    
              case 0:
                  switch (z_button) //this would send us back
                {
                  case 1: // button on
                       //user_input();
                       progstep_backward();
                       
                       break;
                  default:
                      break;    
                }
              default:
                  break;    
           }    
}

void Set_PanoArrayType()  {
     int yUpDown=0;
     
/*   
3x3, 
7x3, 5x5 top third, 7x5 top third
int PanoArrayTypes=1; // 1 is 9 shot center, 2 is 25 shot center, 3 is SevenbyThree, 4 is NineByFive1, 5 is NineByFive2
      
   
	
*/		
		 
		 if (first_time==1){
            //prompt_val=POWERSAVE_PT;
            lcd.empty(); 
            lcd.at(1,2,"Set Array Type"); 
            if (PanoArrayType==PANO_9ShotCenter)            lcd.at(2,3,"9-Shot Center");
            else if (PanoArrayType==PANO_25ShotCenter)       lcd.at(2,2,"25-Shot Center");
            else if (PanoArrayType==PANO_7X3)       lcd.at(2,4,"7x3 Matrix");
            else if (PanoArrayType==PANO_9X5Type1)       lcd.at(2,4,"9x5 Type 1");
            else if (PanoArrayType==PANO_9X5Type2)       lcd.at(2,4,"9x5 Type 2");
            else if (PanoArrayType==PANO_5x5TopThird)       lcd.at(2,4,"5x5 Top1/3");
            else if (PanoArrayType==PANO_7X5TopThird)       lcd.at(2,4,"7x5 Top1/3");
            
            first_time=0;
            delay(500);
            NunChuckQuerywithEC(); //  Use this to clear out any button registry from the last step
            //delay(prompt_time);
            
          }
        
        if ((millis()-NClastread)>50) {
            NClastread=millis();
            //Serial.print("Read");Serial.println(NClastread);
            NunChuckQuerywithEC();
            NunChuckjoybuttons();
        }

        yUpDown=joy_capture_y1(); 
        
        if (yUpDown==-1) { //  up
            PanoArrayType++;
            if (PanoArrayType>PanoArrayTypeOptions) {
              PanoArrayType=PanoArrayTypeOptions;
            }
            else  { 
              first_time=1;
              delay(250);
            }

        } 
        else if (yUpDown==1) { //down
            PanoArrayType--;
            if (PanoArrayType<1) { 
              PanoArrayType=1;
            }
            else  { 
              first_time=1;
              delay(250);
            }
        }
        
          if (PanoArrayType==PANO_9ShotCenter) {
            total_shots_x=3;
            total_shots_y=3;  
          }   
          else if (PanoArrayType==PANO_25ShotCenter) { 
            total_shots_x=5;
            total_shots_y=5;  
          }
          else if (PanoArrayType==PANO_7X3) { 
            total_shots_x=7;
            total_shots_y=3;  
          } 
          else if (PanoArrayType==PANO_9X5Type1) { 
            total_shots_x=9;
            total_shots_y=5;  
          } 
          else if (PanoArrayType==PANO_9X5Type2) { 
            total_shots_x=9;
            total_shots_y=5;  
          } 
          else if (PanoArrayType==PANO_5x5TopThird) { 
            total_shots_x=5;
            total_shots_y=5;  
          }          
          else if (PanoArrayType==PANO_7X5TopThird) { 
            total_shots_x=7;
            total_shots_y=5;  
          }
          
          
          
          
          
          total_pano_shots = total_shots_x*total_shots_y;  //Serial.print("total_pano_shots = ");Serial.println(total_pano_shots);
          camera_total_shots = total_pano_shots+1;//set this to allow us to compare in main loops

        if (c_button) {
        
            //POWERSAVE_PT=prompt_val;
            //eeprom_write(98, POWERSAVE_PT);
            //progtype=0;
            //delay(500);
            progstep_forward();
        
        }
        
        if (z_button) {
        
            // POWERSAVE_PT=prompt_val;
            //eeprom_write(98, POWERSAVE_PT);
            //progtype=0;
            progstep_backward();
        }
		
}



String steps_to_deg_decimal(unsigned long steps) { 
 
//Function is tested for 0 to 99.99 degrees - at 100 degrees and over, the decimal place moves.
   String Degree_display = ""; 
   int temp_degs =(steps*9L)/4000L;  //  9/4000 = 1/444.4444
   int temp_mod = (steps*9L)%4000L;
   int temp_tenths = (temp_mod*10)/4000L;
   int temp_hundredths = ((temp_mod*100)/4000L)-(temp_tenths*10);
   int temp_thousandths = ((temp_mod*1000)/4000L)-(temp_tenths*100)-(temp_hundredths*10);
   //Serial.println(temp_degs);
   //Serial.println(temp_mod);
   //Serial.println(temp_decimal);
   
   if (temp_degs<10) Degree_display += " ";
   Degree_display += temp_degs;
   Degree_display +=".";
   Degree_display +=temp_tenths;
   Degree_display +=temp_hundredths;
   Degree_display +=temp_thousandths;
   if (DEBUG_PANO) Serial.println(Degree_display);
   return Degree_display;
 
}




void Pano_Review_Confirm()
{
              
           if (first_time==1){
             lcd.empty();     
             draw(41,1,4);//lcd.at(1,4,"Review and");
             draw(42,2,2);//lcd.at(2,2,"Confirm Setting");
             //delay(prompt_time);
             delay(500);
             NunChuckQuerywithEC(); //  Use this to clear out any button registry from the last step
             delay(100);
             lcd.empty();
             first_time=0;
             diplay_last_tm =millis();
             Pano_DisplayReviewProg();
             reviewprog = 1;
           }
          
          if ((millis()-diplay_last_tm) >1000){ //test for display update
       
              reviewprog ++;
              diplay_last_tm =millis();
              if (reviewprog >4) reviewprog=1;
              Pano_DisplayReviewProg();

               
          } //end test for display update
          

          

          NunChuckQuerywithEC();
          NunChuckjoybuttons();
   
          if (abs(joy_y_axis)>20) {  //do read time updates to delay program
            reviewprog=4;
            Pano_DisplayReviewProg();
            diplay_last_tm =millis();
          }
          
          
          pano_button_actions_review();
          delay(100);

         
}


void pano_button_actions_review()  {
            switch (c_button) // looking for c button press start
            {
              case 1: // 
                   //user_input();
                   lcd.empty();
                   
                   if (start_delay_sec>0) {
                     lcd.at(1,2,"Delaying Start");
                     
                     //delay (start_delay_sec*60L*1000L);
                     lcd.empty();
                   }
                   
                   disable_AUX();  //

                   
                   draw(49,1,1);//lcd.at(1,1,"Program Running");
                   delay(prompt_time/3);
                   
                   //static_tm = 1; //use a tenth of a second 
                   intval=static_tm+3; // calc interval based on static time only 
                   interval = (long)intval*100; //tenths of a second to ms
                   interval_tm = 0; //set this to 0 to immediately trigger the first shot 
                   
                   if (intval>3) { //SMS Mode
                     lcd.empty(); //clear for non video
                     progstep=250; //  move to the main programcamera_real_fire
                   }
                   camera_fired = 0; //reset the counter
                   Program_Engaged=true;  //leave this for pano
                   Interrupt_Fire_Engaged=true; //just to start off first shot immediately
                   lcd_backlight_cur= 100;
                   first_time=1;
                   lcd.bright(20);
                   if (P2PType==1) 
                   {
                     interrupts();
                     DFSetup(); //setup the ISR
                   //Set the motor position between standard and dragonframes
                     motors[0].position = long(current_steps.x);
                     motors[1].position = long(current_steps.y);
                     display_status();
                     //DFloop();
                   }
                   break;
    
              case 0:
                  switch (z_button) //this would send us back 
                {
                  case 1: // button on
                       //user_input();
                       progstep_backward();
                       break;
                  default:
                      break;    
                }
              default:
                  break;    
           }    
}




void Pano_DisplayReviewProg() {

    switch (reviewprog)  {
        case 1:   // 
          lcd.empty();
          lcd.at(1,2,"Columns:");
          lcd.at(2,5,"Rows:");
          //lcd.at(1,12,motor_steps[0]);
          lcd.at(1,11,total_shots_x);
          lcd.at(2,11,total_shots_y);
        break;
        
        case 2:   // 
          lcd.empty();
          lcd.at(1,1,"Cam Shots:");
          lcd.at(1,12,total_pano_shots);
          //calc_time_remain();
          //display_time(2,6);
        break;
        
        case 3:   // 
          lcd.empty();
          draw(47,1,6);//lcd.at(1,6,"Ready?");
          draw(48,2,2);//lcd.at(2,2,"Press C Button");
        break;            
        case 4:   // 
          //lcd.empty();
          lcd.at(1,1,"StartDly:    min");
          lcd.at(2,2,"Press C Button");
          if (start_delay_sec<20) joy_y_lock_count=0;
          start_delay_sec += joy_capture3();
          if (start_delay_sec<0) {start_delay_sec=500;}
          if (start_delay_sec>500) {start_delay_sec=0;}
          lcd.at(1,11,start_delay_sec); 
           // if (start_delay_min <10)  lcd.at(1,8,"  ");  //clear extra if goes from 3 to 2 or 2 to  1
           // if (start_delay_min <100)  lcd.at(1,9," ");  //clear extra if goes from 3 to 2 or 2 to  1
      
          
        break;
  
    }//end switch


}







void move_motors_pano_basic() { 


int index_x;
int index_y;
int x_mod_pass_1;
int even_odd_row;
int slope_adjustment;

//Figure out which row we are in
if (DEBUG_PANO){ Serial.print("camera_fired;");Serial.println(camera_fired);}
index_y=camera_fired/total_shots_x;
if (DEBUG_PANO){Serial.print("index_y;");Serial.println(index_y);}
x_mod_pass_1 = camera_fired%total_shots_x;
if (DEBUG_PANO){Serial.print("x_mod_pass_1;");Serial.println(x_mod_pass_1);}
even_odd_row=index_y%2;
if (DEBUG_PANO){Serial.print("even_odd_row;");Serial.println(even_odd_row);}
slope_adjustment=even_odd_row*((total_shots_x-1)-2*x_mod_pass_1);
if (DEBUG_PANO){Serial.print("slope_adjustment;");Serial.println(slope_adjustment);}
index_x=x_mod_pass_1+slope_adjustment;
if (DEBUG_PANO){Serial.print("index_x;");Serial.println(index_x);}



fp.x= motor_steps_pt[1][0]-step_per_pano_shot_x*index_x;
if (DEBUG_PANO) {Serial.print("fp.x;");Serial.println(fp.x);}
fp.y= motor_steps_pt[1][1]-step_per_pano_shot_y*index_y;
if (DEBUG_PANO) {Serial.print("fp.y;");Serial.println(fp.y);}


set_target(fp.x,fp.y,0.0); //we are in incremental mode to start abs is false

dda_move(50);
Move_Engaged=false; //clear move engaged flag

return;
}//end move motors basic



void move_motors_pano_accel() { 
  
  
  int index_x;
  int index_y;
  int x_mod_pass_1;
  int even_odd_row;
  int slope_adjustment;
  
  //Figure out which row we are in
  if (DEBUG_PANO){ Serial.print("camera_fired;");Serial.println(camera_fired);}
  index_y=camera_fired/total_shots_x;
  if (DEBUG_PANO){Serial.print("index_y;");Serial.println(index_y);}
  x_mod_pass_1 = camera_fired%total_shots_x;
  if (DEBUG_PANO){Serial.print("x_mod_pass_1;");Serial.println(x_mod_pass_1);}
  even_odd_row=index_y%2;
  if (DEBUG_PANO){Serial.print("even_odd_row;");Serial.println(even_odd_row);}
  slope_adjustment=even_odd_row*((total_shots_x-1)-2*x_mod_pass_1);
  if (DEBUG_PANO){Serial.print("slope_adjustment;");Serial.println(slope_adjustment);}
  index_x=x_mod_pass_1+slope_adjustment;
  if (DEBUG_PANO){Serial.print("index_x;");Serial.println(index_x);}
  
  FloatPoint fp;
  
  fp.x= motor_steps_pt[1][0]-step_per_pano_shot_x*index_x;
  if (DEBUG_PANO) Serial.print("fp.x;");Serial.println(fp.x);
  fp.y= motor_steps_pt[1][1]-step_per_pano_shot_y*index_y;
  if (DEBUG_PANO) Serial.print("fp.y;");Serial.println(fp.y);
  
    
  //set_target(fp.x,fp.y,0.0); //we are in incremental mode to start abs is false
  //dda_move(100);
  setPulsesPerSecond(0,PAN_MAX_JOG_STEPS_PER_SEC);  //this is now pusing through d
  setPulsesPerSecond(1,TILT_MAX_JOG_STEPS_PER_SEC); 
  setupMotorMove(0, long(fp.x));
  //setupMotorMove(0, 50000);
  setupMotorMove(1, long(fp.y));
  
  updateMotorVelocities();
  
  //Move_Engaged=false; //clear move engaged flag
  
  return;
}//end move motors accel



void move_motors_accel_array() {   //this is for the PORTRAITPANO array method
  

  //Figure out which row we are in program
  if (DEBUG_PANO){ Serial.print("camera_fired;");Serial.println(camera_fired);}
  //load from array
  
FloatPoint fp;
if (PanoArrayType==PANO_9ShotCenter){
 fp.x=float(steps_per_shot_max_x)*float(OnionArray9[camera_fired][0]);
 fp.y=float(steps_per_shot_max_y)*float(OnionArray9[camera_fired][1])*-1.0; 
} 
if (PanoArrayType==PANO_25ShotCenter){
	fp.x=float(steps_per_shot_max_x)*float(OnionArray25[camera_fired][0]);
	fp.y=float(steps_per_shot_max_y)*float(OnionArray25[camera_fired][1])*-1.0;
}
else if (PanoArrayType==PANO_7X3){
 fp.x=float(steps_per_shot_max_x)*float(SevenByThree[camera_fired][0]);
 fp.y=float(steps_per_shot_max_y)*float(SevenByThree[camera_fired][1])*-1.0; 
} 
else if (PanoArrayType==PANO_9X5Type1){
 fp.x=float(steps_per_shot_max_x)*float(NineByFive_1[camera_fired][0]);
 fp.y=float(steps_per_shot_max_y)*float(NineByFive_1[camera_fired][1])*-1.0; 
} 
else if (PanoArrayType==PANO_9X5Type2){
 fp.x=float(steps_per_shot_max_x)*float(NineByFive_2[camera_fired][0]);
 fp.y=float(steps_per_shot_max_y)*float(NineByFive_2[camera_fired][1])*-1.0; 
}
else if (PanoArrayType==PANO_5x5TopThird){
 fp.x=float(steps_per_shot_max_x)*float(TopThird25[camera_fired][0]);
 fp.y=float(steps_per_shot_max_y)*float(TopThird25[camera_fired][1])*-1.0; 
} 
else if (PanoArrayType==PANO_7X5TopThird){
 fp.x=float(steps_per_shot_max_x)*float(TopThird7by5[camera_fired][0]);
 fp.y=float(steps_per_shot_max_y)*float(TopThird7by5[camera_fired][1])*-1.0; 
} 

  
  //fp.x= motor_steps_pt[1][0]-step_per_pano_shot_x*index_x;
 if (DEBUG_PANO) Serial.print("fp.x;");Serial.println(fp.x);
   // fp.y= motor_steps_pt[1][1]-step_per_pano_shot_y*index_y;
 if (DEBUG_PANO) Serial.print("fp.y;");Serial.println(fp.y);
  

  setPulsesPerSecond(0,20000); 
  setPulsesPerSecond(1,20000); 
  setupMotorMove(0, long(fp.x));
  //setupMotorMove(0, 50000);
  setupMotorMove(1, long(fp.y));
  
  updateMotorVelocities();
  
  //Move_Engaged=false; //clear move engaged flag
  
  return;
}//end move motors accel


void Move_to_Origin() {   //this is for the PORTRAITPANO array method
  

  //Figure out which row we are in program
  if (DEBUG_PANO){ Serial.print("camera_fired;");Serial.println(camera_fired);}
  //load from array
  
FloatPoint fp;
 fp.x=0.0;
 fp.y=0.0;
  

  setPulsesPerSecond(0,20000); 
  setPulsesPerSecond(1,20000); 
  setupMotorMove(0, long(fp.x));
  //setupMotorMove(0, 50000);
  setupMotorMove(1, long(fp.y));
  
  updateMotorVelocities();
  
  //Move_Engaged=false; //clear move engaged flag
  
  return;
}//end move motors accel
















void calc_pano_move() //pano - calculate other values
    {
      //unsigned long total_shots_x; //calulated value for to divide up scene evenly  ABS(current steps)/max steps per shot+1 = just use integer math
      //unsigned long total_shots_y; //calulated value for to divide up scene evenly
      //unsigned long total_pano_shots; //rows x columns for display
      //unsigned int step_per_pano_shot_x;
      //unsigned int step_per_pano_shot_y;
      total_shots_x = float(abs(current_steps.x)/steps_per_shot_max_x)+2.0; //Serial.print("total_shots_x = ");Serial.println(total_shots_x);
      total_shots_y = float(abs(current_steps.y)/steps_per_shot_max_y)+2.0; //Serial.print("total_shots_y = ");Serial.println(total_shots_y);
      if (abs(current_steps.y)<444.0){ //do a test to see if the tilt angle is very small - indating pano
        total_shots_y=1;
      }
          
      total_pano_shots = total_shots_x*total_shots_y;  //Serial.print("total_pano_shots = ");Serial.println(total_pano_shots);
      camera_total_shots = total_pano_shots;//set this to allow us to compare in main loops
      step_per_pano_shot_x = float((current_steps.x)/(total_shots_x-1.0));  //Serial.print("step_per_pano_shot_x = ");Serial.println(step_per_pano_shot_x);
      step_per_pano_shot_y = float((current_steps.y)/(total_shots_y-1.0));  //Serial.print("step_per_pano_shot_y = ");Serial.println(step_per_pano_shot_y);
    }









void button_actions290()  { //repeat
            switch (c_button) // looking for c button press start
            {
              case 1: // 
                   //user_input();
                   if (POWERSAVE_PT>2)   disable_PT(); 
                   if (POWERSAVE_AUX>2)   disable_AUX();
                   //Program_Engaged=true;
                   camera_fired = 0;  
                   current_steps.x = motors[0].position; //get our motor position variable synced
                   current_steps.y = motors[1].position; //get our motor position variable synced
                   //noInterrupts(); //turn this off while programming for now
                   lcd.bright(100);         
                   if (progtype==PANOGIGA) progstep=206; //  move to the main program at the interval setting - UD050715
                   else if (progtype==PORTRAITPANO) progstep=216; //  move to the main program at the interval setting UD050715
                   first_time=1;
                   delay(prompt_time);
                   NunChuckQuerywithEC(); //  Use this to clear out any button registry from the last step
                   //lcd.bright(0); //run in dimmed mode
                   //lcd_backlight_cur= 0;
                   break;
     
           }    
}





