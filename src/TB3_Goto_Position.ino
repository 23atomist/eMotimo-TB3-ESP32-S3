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


void goto_position(int gotoshot_temp) {
 
  
//We take stock of where we are and hold temps vars for position and camera shots
//reset the camera fired
//run the move, but don't actually move
//Run the mock move starting from zero to the shot - do this so you can actually go backwards.
//Once we get to the move, set this as our target, set current steps as what we have in temp.   Set target for coordinated move, go
//set the camera fired to that amount, pause.

//capture current conditions
FloatPoint BeforeMove;
BeforeMove.x=current_steps.x;
BeforeMove.y=current_steps.y;
BeforeMove.z=current_steps.z; 
int camera_fired_BeforeMove = camera_fired; 
//end capture current concitions.


//reset the move to start fresh
current_steps.x=0.0;
current_steps.y=0.0;
current_steps.z=0.0;
camera_fired = 0;
//end reset the move


//enable the motors
enable_PT();
enable_AUX();


//start the for loop here;
for (int i=0; i < gotoshot_temp; i++){
  
  
      camera_fired++;

      FloatPoint fp;
      fp.x=0.0;
      fp.y=0.0;
      fp.z=0.0;
              
      
       //need this routine for both 2 and three point moves since 3 points can use this logic to determine aux motor progress      
         
        if (camera_fired<keyframe[0][1]) { //Leadin
          program_progress_2PT=1;
          if (DEBUG_GOTO) Serial.print("LeadIn ");
        }
        else if (camera_fired<keyframe[0][2]) {  //Rampup
          program_progress_2PT=2;
          if (DEBUG_GOTO) Serial.print("Rampup ");
        }
        else if (camera_fired<keyframe[0][3]) {  //Linear
          program_progress_2PT=3;
          if (DEBUG_GOTO) Serial.print("Linear "); 
        }
        else if (camera_fired<keyframe[0][4]) {  //RampDown
          program_progress_2PT=4;
          if (DEBUG_GOTO) Serial.print("RampDn ");
        }
        else if (camera_fired<keyframe[0][5]) {  //Leadout
          program_progress_2PT=5;
          if (DEBUG_GOTO) Serial.print("LeadOut ");
        }
        else {
         program_progress_2PT=9;   //Finished
        } 
      
       if (progtype==REG2POINTMOVE || progtype==REV2POINTMOVE || progtype==AUXDISTANCE) {   //2 point moves    
              
       //figure out our move size 2 point SMS and VIDEO   
             if (intval==VIDEO_INTVAL) { //video moves
               fp.x = current_steps.x + motor_get_steps_2pt_video(0);
               fp.y = current_steps.y + motor_get_steps_2pt_video(1);
               fp.z = current_steps.z + motor_get_steps_2pt_video(2);
             }
             else {
               fp.x = current_steps.x + motor_get_steps_2pt(0);
               fp.y = current_steps.y + motor_get_steps_2pt(1);
               fp.z = current_steps.z + motor_get_steps_2pt(2);
             }
       }  //end progtype 0
        
        
      if (progtype==REG3POINTMOVE|| progtype==REV3POINTMOVE) {  //3 point moves
        
              if (camera_fired<keyframe[1][1]) { //Lead In
                program_progress_3PT=101;
                percent = 0.0;
                if (DEBUG_GOTO) Serial.print("LeadIn;");Serial.print(percent);
              
              }       
              
              else if (camera_fired<keyframe[1][2]) { //First Leg
                program_progress_3PT=102;
                percent = float(camera_fired-keyframe[1][1]) / float((keyframe[1][2])-keyframe[1][1]);
                if (DEBUG_GOTO) Serial.print("Leg 1;");Serial.print(percent);
              
              }
              else if (camera_fired<keyframe[1][3]) {  //Second Leg
                program_progress_3PT=103;
                percent = float(camera_fired-keyframe[1][2])/float(keyframe[1][3]-keyframe[1][2]);
                if (DEBUG_GOTO) Serial.print("Leg 2;");Serial.print(percent);  
              }
              //else if (camera_fired<keyframe[3]) {  //Third Leg
              // program_progress_3PT=104;
              // percent = float(camera_fired-keyframe[2])/float(keyframe[3]-keyframe[2]);
              //  if (DEBUG_GOTO) Serial.print("Leg 3;");Serial.print(percent);
              //}
              else if (camera_fired<keyframe[1][4]) {  //Lead Out
                program_progress_3PT=105;
                percent = 0.0;
                if (DEBUG_GOTO) Serial.print("LeadOT;");Serial.print(percent); 
              }    
              
              else {
               program_progress_3PT=109;   //Finished
               if (DEBUG_GOTO) Serial.print("Finished");Serial.print(percent);  
               return;
              } 
              
              Serial.print(";");  
             // DONT FORGET TO UPDATE REAL TIME TESTS ON RT Page
      
      
              fp.x = motor_get_steps_3pt(0);
              fp.y = motor_get_steps_3pt(1);
              fp.z = current_steps.z + motor_get_steps_2pt(2);  //use linear for this
      
      }//end progtype 1
      
      
      if (DEBUG_GOTO) {Serial.print("Shot ");Serial.print(camera_fired);Serial.print(";");}
      
      if (DEBUG_GOTO) {Serial.print("B;");Serial.print(current_steps.x);Serial.print(";");Serial.print(current_steps.y);Serial.print(";");Serial.print(current_steps.z);Serial.print(";");}
      
      set_target(fp.x,fp.y,fp.z); //we are in incremental mode to start abs is false
      
      if (DEBUG_GOTO) {Serial.print("D;");Serial.print(delta_steps.x);Serial.print(";");Serial.print(delta_steps.y);Serial.print(";");Serial.print(delta_steps.z);Serial.print(";");}
      
      //calculate feedrate - update this to be dynamic based on settle window
      
      
      //VIDEO Loop
      if ((progtype==REG2POINTMOVE || progtype==REV2POINTMOVE ||progtype==AUXDISTANCE) && (intval==VIDEO_INTVAL)) { // must lock this down to be only 2point, not three
        feedrate_micros = calculate_feedrate_delay_video();
        if (program_progress_2PT==3) {
            camera_fired=camera_fired+(keyframe[0][3]-keyframe[0][2]); //skip all the calcs mid motor move
        }
        if (DEBUG_GOTO) {Serial.print("Feedrate:");Serial.print(feedrate_micros);Serial.print(";");}
        // pull this from the actual move, reset with just adding deltas to the dda_move(feedrate_micros); 
        
        current_steps.x=fp.x;
        current_steps.y=fp.y;
        current_steps.z=fp.z;
        
        
        
        
      }
      
      //SMS Loop and all three point moves
      else {
        feedrate_micros = calculate_feedrate_delay_1(); //calculates micro delay based on available move time
        if (intval!= VIDEO_INTVAL) feedrate_micros = min((unsigned long)feedrate_micros, 2000UL); //get a slow move, but not too slow, give the motors a chance to rest for non video moves.
        if (DEBUG_GOTO) {Serial.print("Feedrate:");Serial.print(feedrate_micros);Serial.print(";");}
        // pull this from the actual move, reset with just adding deltas to the dda_move(feedrate_micros); 
        current_steps.x=fp.x;
        current_steps.y=fp.y;
        current_steps.z=fp.z;
        
        
        
        
        Move_Engaged=false; //clear move engaged flag
      }
      
      if (DEBUG_GOTO) {Serial.print("A;");Serial.print(current_steps.x);Serial.print(";");Serial.print(current_steps.y);Serial.print(";");Serial.print(current_steps.z);Serial.println(";");}
      
      
}  //end of the for loop

//now that we know the position at the gotoframe, set it as our temp target
FloatPoint Target_Position;
Target_Position.x=current_steps.x; //because current_steps, holds this information
Target_Position.y=current_steps.y;
Target_Position.z=current_steps.z; 

//Reset the current steps vars from the temp.

current_steps.x=BeforeMove.x;
current_steps.y=BeforeMove.y;
current_steps.z=BeforeMove.z; 

//calc the move
synched3PtMove_max(Target_Position.x,Target_Position.y,Target_Position.z);




//Start us moving  
startISR1 ();
do 
{
  if (!nextMoveLoaded)
  {
    updateMotorVelocities();
  }
} while (motorMoving);
//delay(10000);
stopISR1 ();

inprogtype=0; //set this to resume

return;
}//end goto routine

