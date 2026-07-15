#ifndef TB3_UI_H
#define TB3_UI_H

#include <pgmspace.h>

// Self-contained web app (no external resources; CSP-friendly).
static const char TB3_INDEX_HTML[] PROGMEM = R"HTMLUI(<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>TB3 Black</title>
<style>
:root{
  --bg:#0d1117;--panel:#161b22;--panel2:#1c2330;--line:#2d3748;
  --text:#e6edf3;--dim:#8b949e;--accent:#4aa8ff;--good:#3fb950;--warn:#d29922;--bad:#f85149;
  --lcd-bg:#0a2410;--lcd-fg:#5dff7f;
}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%}
body{background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,'Segoe UI',Roboto,sans-serif;padding:14px;max-width:760px;margin:0 auto}
h1{font-size:19px;display:flex;align-items:center;gap:10px;margin-bottom:12px}
h1 small{color:var(--dim);font-weight:400;font-size:12px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--bad);transition:background .3s}
.dot.on{background:var(--good)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:560px){.grid{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px}
.card h2{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);margin-bottom:10px}
.lcd{background:var(--lcd-bg);border-radius:8px;padding:12px 10px;text-align:center;border:1px solid #1a4020;box-shadow:inset 0 2px 10px rgba(0,0,0,.6)}
.lcd div{font:700 clamp(15px,4.4vw,22px)/1.35 ui-monospace,'SF Mono',Menlo,monospace;color:var(--lcd-fg);white-space:pre;letter-spacing:.14em;text-shadow:0 0 8px rgba(93,255,127,.45)}
.stick-wrap{display:flex;gap:14px;align-items:center;justify-content:center}
#stick{touch-action:none;width:210px;height:210px;border-radius:50%;background:radial-gradient(circle at 50% 42%,var(--panel2),#10151f 75%);border:1px solid var(--line);position:relative;flex:none}
#knob{width:74px;height:74px;border-radius:50%;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:linear-gradient(180deg,#3b82f6,#1d4ed8);box-shadow:0 4px 14px rgba(0,0,0,.5);transition:left .12s,top .12s}
#knob.live{transition:none}
.btncol{display:flex;flex-direction:column;gap:12px}
.bbtn{width:74px;padding:16px 0;border-radius:12px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:17px;font-weight:700;cursor:pointer;user-select:none}
.bbtn:active{background:var(--accent);color:#fff}
.bbtn small{display:block;font-size:10px;color:var(--dim);font-weight:400;margin-top:2px}
.slider-row{display:flex;align-items:center;gap:10px;margin-top:14px}
.slider-row label{font-size:11px;color:var(--dim);width:34px}
input[type=range]{flex:1;accent-color:var(--accent);height:34px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center}
.stat{background:var(--panel2);border-radius:8px;padding:8px 4px}
.stat b{display:block;font-size:17px;font-variant-numeric:tabular-nums}
.stat span{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}
.abtn{flex:1;min-width:110px;padding:12px;border-radius:10px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:14px;font-weight:600;cursor:pointer}
.abtn:active{background:var(--accent)}
.abtn.red{border-color:#6e2a2a;background:#2a1416;color:#ff7b72}
.abtn.red:active{background:var(--bad);color:#fff}
.abtn.on{border-color:var(--good);color:var(--good)}
.abtn:disabled{opacity:.4;cursor:default}
.kv{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--line);font-size:13px}
.kv:last-child{border-bottom:0}
.kv span{color:var(--dim)}
input[type=text],input[type=password]{width:100%;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--panel2);color:var(--text);margin-bottom:8px;font-size:14px}
.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:10px 18px;font-size:13px;opacity:0;pointer-events:none;transition:opacity .25s;max-width:90vw}
.toast.show{opacity:1}
footer{color:var(--dim);font-size:11px;text-align:center;margin-top:16px}
</style>
</head>
<body>
<h1><span class="dot" id="dot"></span>TB3&nbsp;Black <small id="fw">motion control</small></h1>

<div class="card" style="margin-bottom:12px">
  <div class="lcd"><div id="l1">                </div><div id="l2">                </div></div>
</div>

<div class="grid">
  <div class="card">
    <h2>Control</h2>
    <div class="stick-wrap">
      <div id="stick"><div id="knob"></div></div>
      <div class="btncol">
        <button class="bbtn" id="btnC">C<small>select</small></button>
        <button class="bbtn" id="btnZ">Z<small>back</small></button>
      </div>
    </div>
    <div class="slider-row">
      <label>AUX</label>
      <input type="range" id="aux" min="-100" max="100" value="0">
    </div>
    <div class="row"><button class="abtn red" id="stop">STOP</button></div>
  </div>

  <div class="card">
    <h2>Status</h2>
    <div class="stats">
      <div class="stat"><b id="pPan">0</b><span>pan</span></div>
      <div class="stat"><b id="pTilt">0</b><span>tilt</span></div>
      <div class="stat"><b id="pAux">0</b><span>aux</span></div>
      <div class="stat"><b id="batt">--</b><span>battery</span></div>
      <div class="stat"><b id="shots">0</b><span>shots</span></div>
      <div class="stat"><b id="state">--</b><span>state</span></div>
    </div>
    <h2 style="margin-top:14px">Camera</h2>
    <div class="row">
      <button class="abtn" id="fire">&#128247; Fire</button>
      <button class="abtn" id="focus">&#9678; Focus</button>
    </div>
  </div>

  <div class="card">
    <h2>Bluetooth gamepad</h2>
    <div class="kv"><span>Controller</span><b id="btName">none</b></div>
    <div class="row">
      <button class="abtn" id="pair">Pairing: off</button>
      <button class="abtn" id="forget">Forget pads</button>
    </div>
    <footer style="text-align:left;margin-top:10px">BLE pads only (Xbox Series, 8BitDo/Stadia in BLE mode). Pairing runs on the device itself.</footer>
  </div>

  <div class="card">
    <h2>Network</h2>
    <div class="kv"><span>AP</span><b id="apip">10.31.31.1</b></div>
    <div class="kv"><span>Home WiFi</span><b id="staip">not joined</b></div>
    <div style="margin-top:10px">
      <input type="text" id="ssid" placeholder="Home WiFi SSID (optional)">
      <input type="password" id="pass" placeholder="Password">
      <div class="row"><button class="abtn" id="savewifi">Save &amp; reconnect</button></div>
    </div>
  </div>

  <div class="card">
    <h2>Program</h2>
    <div id="progList" style="display:flex;flex-direction:column;gap:6px"></div>
    <div id="progHint" style="color:var(--dim);font-size:12px;margin-top:8px"></div>
  </div>

  <div class="card">
    <h2>Firmware Update</h2>
    <input type="file" id="otaFile" accept=".bin" style="margin-bottom:8px">
    <div class="row"><button class="abtn" id="otaBtn" onclick="doOta()">Upload &amp; Flash</button></div>
    <div style="background:var(--panel2);border-radius:6px;height:10px;margin-top:10px;overflow:hidden">
      <div id="otaBar" style="height:100%;width:0;background:var(--accent);transition:width .2s"></div>
    </div>
    <div id="otaMsg" style="color:var(--dim);font-size:12px;margin-top:6px"></div>
  </div>
</div>

<footer id="foot">connecting&hellip;</footer>
<div class="toast" id="toast"></div>

<script>
"use strict";
var ws=null,wsOK=false,joy={x:0,y:0,aux:0},joyActive=false,heldBtn=null;
function $(i){return document.getElementById(i)}
function toast(m){var t=$('toast');t.textContent=m;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove('show')},2200)}
function api(p,body,cb){
  fetch(p,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})
    .then(function(r){return r.json()}).then(function(j){cb&&cb(j)})
    .catch(function(){toast('request failed')});
}
function send(o){if(wsOK){ws.send(JSON.stringify(o))}else{api('/api/joy',o)}}

/* ---- websocket ---- */
function connect(){
  ws=new WebSocket('ws://'+location.host+'/ws');
  ws.onopen=function(){wsOK=true;$('dot').classList.add('on');$('foot').textContent='live'};
  ws.onclose=function(){wsOK=false;$('dot').classList.remove('on');$('foot').textContent='reconnecting…';setTimeout(connect,1500)};
  ws.onmessage=function(e){
    var m;try{m=JSON.parse(e.data)}catch(_){return}
    if(m.type!=='tick')return;
    $('l1').textContent=m.lcd[0];$('l2').textContent=m.lcd[1];
    $('pPan').textContent=Math.round(m.pos[0]);
    $('pTilt').textContent=Math.round(m.pos[1]);
    $('pAux').textContent=Math.round(m.pos[2]);
    $('batt').textContent=m.batt.toFixed(1)+'V';
    $('shots').textContent=m.fired+(m.total?'/'+m.total:'');
    $('state').textContent=(m.moving?'moving':(m.prog?'running':'idle'));
    $('btName').textContent=m.bt.c?m.bt.n:'none';
    var p=$('pair');p.textContent='Pairing: '+(m.bt.p?'on':'off');p.classList.toggle('on',m.bt.p);
    if(m.sta){$('staip').textContent=m.sta}
  };
}
connect();

/* ---- periodic input pump: refresh while any input active (deadman) ---- */
setInterval(function(){
  if(joyActive||joy.aux!==0){send({t:'joy',x:joy.x,y:joy.y,aux:joy.aux})}
  if(heldBtn){send({t:'btn',b:heldBtn,ms:350})}
},120);

/* ---- joystick ---- */
(function(){
  var pad=$('stick'),knob=$('knob'),pid=null;
  function setKnob(nx,ny){knob.style.left=(50+nx*32)+'%';knob.style.top=(50-ny*32)+'%'}
  function ev2n(e){
    var r=pad.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;
    var nx=(e.clientX-cx)/(r.width*.40),ny=(cy-e.clientY)/(r.height*.40);
    var m=Math.hypot(nx,ny);if(m>1){nx/=m;ny/=m}
    return{x:nx,y:ny};
  }
  pad.addEventListener('pointerdown',function(e){
    pid=e.pointerId;pad.setPointerCapture(pid);knob.classList.add('live');
    var n=ev2n(e);joy.x=Math.round(n.x*100);joy.y=Math.round(n.y*100);joyActive=true;setKnob(n.x,n.y);
    send({t:'joy',x:joy.x,y:joy.y,aux:joy.aux});e.preventDefault();
  });
  pad.addEventListener('pointermove',function(e){
    if(e.pointerId!==pid)return;
    var n=ev2n(e);joy.x=Math.round(n.x*100);joy.y=Math.round(n.y*100);setKnob(n.x,n.y);
  });
  function up(e){
    if(e.pointerId!==pid)return;pid=null;knob.classList.remove('live');
    joy.x=0;joy.y=0;joyActive=false;setKnob(0,0);
    send({t:'joy',x:0,y:0,aux:joy.aux});
  }
  pad.addEventListener('pointerup',up);pad.addEventListener('pointercancel',up);
})();

/* ---- aux slider (springs back) ---- */
(function(){
  var s=$('aux');
  s.addEventListener('input',function(){joy.aux=parseInt(s.value,10);send({t:'joy',x:joy.x,y:joy.y,aux:joy.aux})});
  function rel(){s.value=0;joy.aux=0;send({t:'joy',x:joy.x,y:joy.y,aux:0})}
  s.addEventListener('pointerup',rel);s.addEventListener('pointercancel',rel);
})();

/* ---- C / Z buttons (hold-capable) ---- */
function bindBtn(id,code){
  var el=$(id);
  el.addEventListener('pointerdown',function(e){heldBtn=code;send({t:'btn',b:code,ms:350});e.preventDefault()});
  function up(){heldBtn=null}
  el.addEventListener('pointerup',up);el.addEventListener('pointercancel',up);el.addEventListener('pointerleave',up);
}
bindBtn('btnC','c');bindBtn('btnZ','z');

/* ---- keyboard (desktop) ---- */
var keys={};
document.addEventListener('keydown',function(e){
  if(e.repeat)return;var k=e.key.toLowerCase();keys[k]=true;
  if(k==='c'){heldBtn='c';send({t:'btn',b:'c',ms:350})}
  if(k==='z'){heldBtn='z';send({t:'btn',b:'z',ms:350})}
  kjoy();
});
document.addEventListener('keyup',function(e){
  var k=e.key.toLowerCase();keys[k]=false;
  if(k==='c'||k==='z')heldBtn=null;
  kjoy();
});
function kjoy(){
  var x=(keys.d?100:0)+(keys.a?-100:0),y=(keys.w?100:0)+(keys.s?-100:0);
  if(x||y){joy.x=x;joy.y=y;joyActive=true}
  else if(joyActive&&!x&&!y){joy.x=0;joy.y=0;joyActive=false}
  send({t:'joy',x:joy.x,y:joy.y,aux:joy.aux});
}

/* ---- actions ---- */
$('stop').onclick=function(){api('/api/stop',{},function(){toast('stopped')})};
$('fire').onclick=function(){api('/api/camera',{action:'shoot',ms:150},function(){toast('shutter fired')})};
$('focus').onclick=function(){api('/api/camera',{action:'focus',ms:800},function(){toast('focusing')})};
$('pair').onclick=function(){
  var on=$('pair').textContent.indexOf('off')>=0;
  api('/api/bt',{pairing:on},function(){toast(on?'pairing enabled - press pair button on controller':'pairing disabled')});
};
$('forget').onclick=function(){api('/api/bt',{forget:true},function(){toast('bluetooth keys cleared')})};
$('savewifi').onclick=function(){
  api('/api/wifi',{ssid:$('ssid').value,pass:$('pass').value},function(){toast('saved - reconnecting')});
};
api('/api/info',null,function(j){$('fw').textContent='v'+j.version+' · '+j.build});

/* ---- program picker ---- */
function loadPrograms(){
  api('/api/program',null,function(p){
    var box=$('progList');box.innerHTML='';
    p.names.forEach(function(name,i){
      var b=document.createElement('button');
      b.textContent=name;
      b.className='abtn'+(i===p.current?' on':'');
      b.disabled=!p.selectable;
      b.onclick=function(){
        api('/api/program',{type:i,select:true},function(){setTimeout(loadPrograms,300)});
      };
      box.appendChild(b);
    });
    $('progHint').textContent=p.selectable
      ?'Tap a program to select and enter it.'
      :'Return to the top menu on the device to change programs.';
  });
}
loadPrograms();
setInterval(loadPrograms,4000);

/* ---- OTA firmware upload ---- */
async function doOta(){
  const f = document.getElementById('otaFile').files[0];
  const msg = document.getElementById('otaMsg');
  const btn = document.getElementById('otaBtn');
  if(!f){ msg.textContent='Choose a firmware.bin first.'; return; }
  btn.disabled = true;
  const st = await (await fetch('/api/ota')).json();
  if(!st.safe){ msg.textContent='Busy — stop the program first.'; btn.disabled=false; return; }
  const fd = new FormData(); fd.append('firmware', f);
  const xhr = new XMLHttpRequest();
  xhr.open('POST','/api/ota');
  xhr.upload.onprogress = e => {
    if(e.lengthComputable){
      const pct = Math.round(e.loaded*100/e.total);
      document.getElementById('otaBar').style.width = pct+'%';
      msg.textContent = 'Uploading '+pct+'%';
    }
  };
  xhr.onload = ()=>{
    if(xhr.status===200){ msg.textContent='Flashed — device rebooting…'; }
    else { msg.textContent='Failed: '+xhr.responseText; btn.disabled=false; }
  };
  xhr.onerror = ()=>{ msg.textContent='Upload connection lost.'; btn.disabled=false; };
  msg.textContent='Uploading…'; xhr.send(fd);
}
</script>
</body>
</html>
)HTMLUI";

#endif
