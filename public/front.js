// Shared helpers
const $ = (id)=>document.getElementById(id);
const show = el=>el.classList.remove("hidden");
const hide = el=>el.classList.add("hidden");
const token = localStorage.getItem("fa_token");

if(!token){ location.href="/login.html"; }

// Simple POST helper
const api = async (p,b)=>{
  const r = await fetch(p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b||{})});
  if(!r.ok) throw new Error((await r.json()).error||"Request failed"); return r.json();
};

// Presence + sockets
let socket, pc, localStream, role, mode, roomId;
const remoteAudio = $("remoteAudio");
let timerInt, startAt=0;

function startTimer(){
  startAt = Date.now();
  clearInterval(timerInt);
  timerInt = setInterval(()=>{
    const s = Math.floor((Date.now()-startAt)/1000);
    $("timer").textContent = `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
  },1000);
}

async function refreshMe(){
  try{
    const r = await api("/api/me",{token});
    $("gender").value = r.profile.gender||"";
    $("language").value = r.profile.language||"";
    $("location").value = r.profile.location||"";
  }catch(e){}
}

function ensureSocket(){
  if(socket) return;
  socket = io();
  socket.on("connect", ()=> socket.emit("auth",{token}));
  socket.on("auth_ok", ()=> socket.emit("presence_get"));
  socket.on("presence", renderPresence);
  socket.on("queued", ({mode})=> $("status").textContent = `Waiting for ${mode} partner…`);
  socket.on("match_found", async ({roomId:rid, role:r, mode:m})=>{
    roomId=rid; role=r; mode=m;
    await startCall();
  });
  socket.on("signal", async ({data})=>{
    if(!pc) return;
    if(data.type==="offer"){
      await pc.setRemoteDescription(new RTCSessionDescription(data));
      const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
      socket.emit("signal",{roomId,data:pc.localDescription});
    } else if(data.type==="answer"){
      await pc.setRemoteDescription(new RTCSessionDescription(data));
    } else if(data.candidate){
      try{ await pc.addIceCandidate(data);}catch{}
    }
  });
  socket.on("peer_hangup", ()=> endCall("Peer hung up"));
}

function renderPresence(list){
  const box = $("online"); box.innerHTML="";
  list.forEach(u=>{
    const div = document.createElement("button");
    div.className="row item";
    div.textContent = `${u.name||u.phone} • ${u.gender||"-"} • ${u.language||"-"}`;
    div.onclick = ()=> socket.emit("call_user",{targetToken:u.token, mode:"video"}); // (optional endpoint if you add it)
    box.appendChild(div);
  });
}

$("save").onclick = async ()=>{
  try{
    await api("/api/prefs",{token, gender:$("gender").value, language:$("language").value, location:$("location").value});
    $("save_msg").textContent = "Saved ✓";
    socket?.emit("presence_get");
  }catch(e){ $("save_msg").textContent = e.message; }
};

$("rand_audio").onclick = ()=> { ensureSocket(); $("status").textContent=""; socket.emit("find_match",{mode:"audio"}); };
$("rand_video").onclick = ()=> { ensureSocket(); $("status").textContent=""; socket.emit("find_match",{mode:"video"}); };
$("cancel").onclick     = ()=> { $("status").textContent="Cancelled"; };

$("btn_logout").onclick = ()=>{
  localStorage.removeItem("fa_token");
  location.href="/login.html";
};

async function startCall(){
  show($("call_box")); startTimer();
  const audioOnly = (mode==="audio");
  $("localVideo").classList.toggle("hidden", audioOnly);
  $("remoteVideo").classList.toggle("hidden", audioOnly);

  localStream = await navigator.mediaDevices.getUserMedia(audioOnly?{audio:true,video:false}:{audio:true,video:true});
  $("localVideo").srcObject = localStream;

  pc = new RTCPeerConnection({ iceServers:[{urls:"stun:stun.l.google.com:19302"}] });
  localStream.getTracks().forEach(t=> pc.addTrack(t, localStream));
  pc.ontrack = e=>{
    const s=e.streams[0];
    if(!s) return;
    s.getTracks().forEach(tr=>{
      if(tr.kind==="video"){ $("remoteVideo").srcObject=s; }
      if(tr.kind==="audio"){ remoteAudio.srcObject=s; }
    });
  };
  pc.onicecandidate = e=> e.candidate && socket.emit("signal",{roomId,data:e.candidate});
  socket.emit("join_room",{roomId});

  if(role==="offerer"){
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    socket.emit("signal",{roomId,data:pc.localDescription});
  }
}

$("hangup").onclick = ()=> { socket?.emit("hangup",{roomId}); endCall("You hung up"); };
function endCall(msg){
  clearInterval(timerInt); $("timer").textContent="";
  try{ pc && pc.close(); }catch{} pc=null;
  try{ localStream && localStream.getTracks().forEach(t=>t.stop()); }catch{} localStream=null;
  hide($("call_box")); $("status").textContent = msg||"Call ended.";
}

refreshMe(); ensureSocket();
