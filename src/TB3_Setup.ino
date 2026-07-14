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

void Setup_AUX_ON()   {
     int yUpDown=0;
     
     //int displayvar=0;   
         
         if (first_time==1){
            //prompt_val=AUX_ON;
            lcd.empty();  
            draw(74,1,1);//lcd.at(1,1,"Aux Motor:");
            if (AUX_ON==0)  lcd.at(1,12,"OFF");
            if (AUX_ON==1)  lcd.at(1,12,"ON");
            draw(65,2,1);//lcd.at(2,1,"UpDown  C-Select");
            first_time=0;
            delay(350);
            NunChuckQuerywithEC(); //  Use this to clear out any button registry from the last step
            //delay(prompt_time);
            
          }
        
        if ((millis()-NClastread)>50) {
            NClastread=millis();
            NunChuckQuerywithEC();
            NunChuckjoybuttons();
        }

        yUpDown=joy_capture_y1(); 
        
        if (yUpDown==-1) { //  up
            if (AUX_ON==0) {
              AUX_ON=1;
              first_time=1;
              delay(250);
            }
            
        } 
        else if (yUpDown==1) { //down
            if (AUX_ON==1) {
              AUX_ON=0;
              first_time=1;
              delay(250);
            }
            
            
        }
        if (AUX_ON>1) {
              AUX_ON=0;
              first_time=1;
              delay(250);
        }
            
        

        if (c_button || z_button) {
        
            eeprom_write(100, AUX_ON);
            //delay(350);
            //progstep_forward();
			
			if (c_button) progstep_forward();
			else {
				progtype=SETUPMENU;
				progstep_goto(0);
			}
			
			
            delay(350);
            NunChuckQuerywithEC();
      
        }
}



void Setup_PAUSE_ENABLED()   {
     int yUpDown=0;
     
     //int displayvar=0;   
         
         if (first_time==1){
            lcd.empty();  
            draw(62,1,1);//lcd.at(1,1,"Pause ")
            if (PAUSE_ENABLED==0){
                draw(68,1,8);//lcd.at(1,7,"Disabled")
            }  
            if (PAUSE_ENABLED==1) {
                draw(67,1,8);//lcd.at(1,7,"Enabled")
            } 
            draw(65,2,1);//lcd.at(2,1,"UpDown  C-Select");
            first_time=0;
            delay(350);
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
            if (PAUSE_ENABLED==0) {
              PAUSE_ENABLED=1;
              first_time=1;
              delay(250);
            }
            
        } 
        else if (yUpDown==1) { //down
            if (PAUSE_ENABLED==1) {
              PAUSE_ENABLED=0;
              first_time=1;
              delay(250);
            }
            
        }
        if (PAUSE_ENABLED>1) { //in case bad values for EEPROM
              PAUSE_ENABLED=0;
              first_time=1;
              delay(250);
        }

        if (c_button || z_button ) {
        
            eeprom_write(101, PAUSE_ENABLED);
            //progtype=0;
            if (c_button) progstep_forward();
            else progstep_backward();
            delay(350);
            NunChuckQuerywithEC();
         
        }
        
}

void Setup_POWERSAVE_PT()   {
     int yUpDown=0;
     
     //int displayvar=0;   
         
         if (first_time==1){
            //prompt_val=POWERSAVE_PT;
            lcd.empty(); 
            lcd.at(1,1,"PT Motors on"); 
            if (POWERSAVE_PT==1)      draw(70,2,1); //lcd.at(2,1,"Always");
            if (POWERSAVE_PT==2)      draw(71,2,1); //lcd.at(2,1,"Program");
            if (POWERSAVE_PT==3)      draw(72,2,1); //lcd.at(2,1,"Shoot (accuracy)");
            if (POWERSAVE_PT==4)      draw(73,2,1); //lcd.at(2,1,"Shoot (pwr save)");
            //lcd.at(2,12,"C-Set");            
            first_time=0;
            delay(350);
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
            POWERSAVE_PT++;
            if (POWERSAVE_PT>4) {
              POWERSAVE_PT=4;
            }
            else  { 
              first_time=1;
              delay(250);
            }

        } 
        else if (yUpDown==1) { //down
            POWERSAVE_PT--;
            if (POWERSAVE_PT<1) { 
              POWERSAVE_PT=1;
            }
            else  { 
              first_time=1;
              delay(250);
            }
        }
        
        if (POWERSAVE_PT>100) POWERSAVE_PT=2;

        if (c_button||z_button) {
        
            //POWERSAVE_PT=prompt_val;
            eeprom_write(96, POWERSAVE_PT);
            progtype=0;
            //delay(350);
            if (c_button) progstep_forward();
			else progstep_backward();
            delay(350);
            NunChuckQuerywithEC();
        
        }
        
}


void Setup_POWERSAVE_AUX()   {
     int yUpDown=0;
     
     //int displayvar=0;   
         
         if (first_time==1){
            //prompt_val=POWERSAVE_AUX;
            lcd.empty(); 
            lcd.at(1,1,"AUX Motors On:"); 
            if (POWERSAVE_AUX==1)      draw(70,2,1); //lcd.at(2,1,"Always");
            if (POWERSAVE_AUX==2)      draw(71,2,1); //lcd.at(2,1,"Program");
            if (POWERSAVE_AUX==3)      draw(72,2,1); //lcd.at(2,1,"Shoot (accuracy)");
            if (POWERSAVE_AUX==4)      draw(73,2,1); //lcd.at(2,1,"Shoot (pwr save)");
            //lcd.at(2,12,"C-Set");            
            first_time=0;
            delay(350);
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
            POWERSAVE_AUX++;
            if (POWERSAVE_AUX>4) {
              POWERSAVE_AUX=4;
            }
            else  { 
              first_time=1;
              delay(250);
            }

        } 
        else if (yUpDown==1) { //down
            POWERSAVE_AUX--;
            if (POWERSAVE_AUX<1) {
              POWERSAVE_AUX=1;
            }
            else  { 
              first_time=1;
              delay(250);
            }
        }
        
        if (POWERSAVE_AUX>100) POWERSAVE_AUX=2;

if (c_button||z_button) {
        
            //POWERSAVE_AUX=prompt_val;
            eeprom_write(98, POWERSAVE_AUX);
            progtype=0;
            //lcd.empty();
            if (c_button) progstep_forward();
            else progstep_backward();
            delay(350);
            NunChuckQuerywithEC();

        
        }

}



void Setup_LCD_BRIGHTNESS_DURING_RUN()   { //issue with this loop jumping out on first touch of up down - reads ghose C press.
    int yUpDown=0;
     
     
         if (first_time==1){
            lcd.empty();  
            lcd.at(1,1,"BkLite On Run: ");
            lcd.at(1,15,LCD_BRIGHTNESS_DURING_RUN);
            draw(65,2,1);//lcd.at(2,1,"UpDown  C-Select");
            first_time=0;
            delay(250);
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
              LCD_BRIGHTNESS_DURING_RUN++;
              if (LCD_BRIGHTNESS_DURING_RUN>8) LCD_BRIGHTNESS_DURING_RUN=8;
              lcd.bright(LCD_BRIGHTNESS_DURING_RUN); //this seems to ghost press the C
              c_button=0;
              first_time=1;
              //delay(50);
            }
            
        
        else if (yUpDown==1) { //down
              LCD_BRIGHTNESS_DURING_RUN--;
              if (LCD_BRIGHTNESS_DURING_RUN<1) LCD_BRIGHTNESS_DURING_RUN=1;
              lcd.bright(LCD_BRIGHTNESS_DURING_RUN);
              c_button=0;
              first_time=1;
              //delay(50);
            }
            
   

if (c_button||z_button) {
        
            //LCD Values
            eeprom_write(102, LCD_BRIGHTNESS_DURING_RUN);
            progtype=0;
            //lcd.empty();
            //lcd.at(1,1,"Return Main Menu");
            lcd.bright(4);
            //delay(100);
            NunChuckQuerywithEC(); //  Use this to clear out any button registry from the last step
            if (c_button) progstep_forward();
            else progstep_backward();
            delay(350);
            NunChuckQuerywithEC();
        
        }
        

}

void Setup_Max_AUX_Motor_Speed()   { //issue with this loop jumping out on first touch of up down - reads ghose C press.
    int yUpDown=0;
     
     
         if (first_time==1){
            lcd.empty();  
            lcd.at(1,1,"Max Speed:  ");
            lcd.at(1,12,AUX_MAX_JOG_STEPS_PER_SEC);
            draw(65,2,1);//lcd.at(2,1,"UpDown  C-Select");
            first_time=0;
            delay(250);
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
              AUX_MAX_JOG_STEPS_PER_SEC+=500;
              if (AUX_MAX_JOG_STEPS_PER_SEC>20000) AUX_MAX_JOG_STEPS_PER_SEC=20000;
              //lcd.bright(LCD_BRIGHTNESS_DURING_RUN); //this seems to ghost press the C
              c_button=0;
              first_time=1;
              //delay(50);
            }
            
        
        else if (yUpDown==1) { //down
              AUX_MAX_JOG_STEPS_PER_SEC-=500;
              if (AUX_MAX_JOG_STEPS_PER_SEC<2000) AUX_MAX_JOG_STEPS_PER_SEC=2000;
              //lcd.bright(LCD_BRIGHTNESS_DURING_RUN);
              c_button=0;
              first_time=1;
              //delay(50);
            }
            
   


if (c_button || z_button) {
        
            //POWERSAVE_AUX=prompt_val;
            eeprom_write(104, AUX_MAX_JOG_STEPS_PER_SEC);
            if (c_button) progstep_forward();
            else progstep_backward();
            delay(350);
            NunChuckQuerywithEC(); //  Use this to clear out any button registry from the last button

        }
        
        
        
}

void Setup_AUX_Motor_DIR()  {
     int yUpDown=0;
     
     //int displayvar=0;   
         
         if (first_time==1){
            //prompt_val=AUX_ON;
            lcd.empty();  
            lcd.at(1,1,"Aux Reversed:");
            if (AUX_REV==0)  lcd.at(1,14,"OFF");
            if (AUX_REV==1)  lcd.at(1,14,"ON");
            draw(65,2,1);//lcd.at(2,1,"UpDown  C-Select");
            first_time=0;
            delay(350);
            NunChuckQuerywithEC(); //  Use this to clear out any button registry from the last step
            //delay(prompt_time);
            
          }
        
        if ((millis()-NClastread)>50) {
            NClastread=millis();
            NunChuckQuerywithEC();
            NunChuckjoybuttons();
        }

        yUpDown=joy_capture_y1(); 
        
        if (yUpDown==-1) { //  up
            if (AUX_REV==0) {
              AUX_REV=1;
              first_time=1;
              delay(250);
            }
            
        } 
        else if (yUpDown==1) { //down
            if (AUX_REV==1) {
              AUX_REV=0;
              first_time=1;
              delay(250);
            }
            
            
        }
        if (AUX_REV>1) {
              AUX_REV=0;
              first_time=1;
              delay(250);
        }
            
      
        
        if (c_button||z_button) {
        
            eeprom_write(106, AUX_REV);            
            progtype=0;
            lcd.empty();
            lcd.at(1,1,"Return Main Menu");
            delay(1500);
            NunChuckQuerywithEC(); //  Use this to clear out any button registry from the last button
            //progstep_forward();
            //progstep_goto(0);
			if (c_button) progstep_goto(0);
			else progstep_backward();
        }
        

}

void Set_Shot_Repeat()   {   //

	int yUpDown=0;
	
	if (first_time==1){
		//int sequence_repeat_type=1; //1 Defaults - Run Once, 0 Continuous Loop,  -1 Repeat Forward
		lcd.empty();
		lcd.at(1,1,"Select Shot Type");
		if (sequence_repeat_type==1)			 lcd.at(2,1,"Run Once");
		if (sequence_repeat_type==0)             lcd.at(2,1,"Continuous Loop");
		if (sequence_repeat_type==-1)            lcd.at(2,1,"Repeat Forward"); //not currently supported
		//lcd.at(2,12,"C-Set");
		first_time=0;
		delay(350);
		NunChuckQuerywithEC(); //  Use this to clear out any button registry from the last step
		//delay(prompt_time);
		
	}
	
	if ((millis()-NClastread)>50) {
		NClastread=millis();
		NunChuckQuerywithEC();
		NunChuckjoybuttons();
	}

	yUpDown=joy_capture_y1();
	
	if (yUpDown==-1) { //  up
		sequence_repeat_type++;
		if (sequence_repeat_type>1) {
			sequence_repeat_type=1;
		}
		else  {
			first_time=1;
			delay(250);
		}

	}
	else if (yUpDown==1) { //down
		sequence_repeat_type--;
		if (sequence_repeat_type<0) {
			sequence_repeat_type=0;
		}
		else  {
			first_time=1;
			delay(250);
		}
	}
	
	if (c_button) {
		
		//POWERSAVE_AUX=prompt_val;
		//eeprom_write(98, POWERSAVE_AUX);
		//progtype=0;
		//lcd.empty();
		progstep_forward();
		delay(350);
		NunChuckQuerywithEC();
	}
	else if (z_button) {
		
		//POWERSAVE_AUX=prompt_val;
		//eeprom_write(98, POWERSAVE_AUX);
		//progtype=0;
		//lcd.empty();
		progstep_backward();
		delay(350);
		NunChuckQuerywithEC();
		
	}

}
