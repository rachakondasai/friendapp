const phone = localStorage.getItem("phone");
const name  = localStorage.getItem("name");
if (!phone) location.href="/login";

const $ = (id)=>document.getElementById(id);
$("me_name").textContent = name || "User";
$("me_phone").textContent = phone;

(async ()=>{
  try{
    const r=await fetch("/api/me",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phone})});
    const j=await r.json();
    $("me_avatar").src=j.profile.avatar;
    $("me_name").textContent = j.profile.name; // includes emoji from server
    $("gender").value = j.prefs.gender || "";
    $("language").value = j.prefs.language || "";
    $("location").value = j.prefs.location || "";
  }catch{}
})();

$("logout").onclick=()=>{ localStorage.clear(); location.href="/login"; };

$("save").onclick=async()=>{
  $("status").textContent="Saving...";
  const body={ phone, gender:$("gender").value, language:$("language").value, location:$("location").value };
  const r=await fetch("/api/prefs",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const j=await r.json();
  $("status").textContent = r.ok ? "Saved." : (j.error||"Save failed");
};

// socket + presence
const socket = io();
socket.on("connect", ()=> socket.emit("auth",{ phone }));
socket.on("auth_ok", ()=> { socket.emit("presence_get"); refreshOnline(); });
socket.on("status", ({text})=> $("status").textContent=text);

socket.on("presence", list => renderOnline(list));

function renderOnline(list){
  const box=$("online"); box.innerHTML="";
  list.filter(u=>u.phone!==phone).forEach(u=>{
    const emoji = (u.prefs.gender||"").toLowerCase()==="male"?"♂️":(u.prefs.gender||"").toLowerCase()==="female"?"♀️":"🙂";
    const busy = u.inCall ? " • in call" : (u.ringing ? " • ringing" : "");
    const d=document.createElement("div");
    d.className="row";
    d.innerHTML=`<img src="${u.avatar}" class="avatar sm"><div class="flex1"><div class="bold">${u.name} ${emoji}</div><div class="muted">${u.prefs.language||"-"} • ${u.prefs.gender||"-"}${busy}</div></div><button ${u.inCall?"disabled":""}>Call</button>`;
    d.querySelector("button").onclick=()=> $("status").textContent="Tip: Random will auto pick a best match.";
    box.appendChild(d);
  });
}

async function refreshOnline(){
  const r=await fetch("/api/online"); const j=await r.json(); renderOnline(j.online);
}

function find(mode){
  $("status").textContent=`Looking for ${mode} partner...`;
  socket.emit("find_match",{ mode, phone });
}
$("randAudio").onclick=()=> find("audio");
$("randVideo").onclick=()=> find("video");
$("cancel").onclick =()=> $("status").textContent="Cancelled.";

// ---- calling (unchanged) ----
let pc=null, localStream=null, role=null, roomId=null;
const remoteAudio = $("remoteAudio");

socket.on("outgoing_call",({roomId:rid,mode,to})=>{
  role="offerer"; roomId=rid;
  $("status").textContent=`Calling ${to?.name||""}...`;
  startCall(mode);
});
socket.on("incoming_call",({roomId:rid,mode,from})=>{
  role="answerer"; roomId=rid;
  $("status").textContent=`Incoming ${mode} call from ${from?.name||""}...`;
  // show accept/decline UI if you want; for now auto-accept:
  socket.emit("call_accept",{ roomId, phone });
  startCall(mode);
});
socket.on("call_declined",()=> $("status").textContent="Declined.");
socket.on("call_cancelled",()=> $("status").textContent="Cancelled.");

socket.on("signal",async ({data})=>{
  if (!pc) return;
  if (data.type==="offer"){
    await pc.setRemoteDescription(new RTCSessionDescription(data));
    const ans=await pc.createAnswer(); await pc.setLocalDescription(ans);
    socket.emit("signal",{ roomId, data: pc.localDescription });
  } else if (data.type==="answer"){
    await pc.setRemoteDescription(new RTCSessionDescription(data));
  } else if (data.candidate){
    try{ await pc.addIceCandidate(data);}catch{}
  }
});

async function startCall(mode){
  $("call").classList.remove("hidden");
  const audioOnly = mode==="audio";
  const constraints = audioOnly? {audio:true,video:false}:{audio:true,video:true};
  localStream = await navigator.mediaDevices.getUserMedia(constraints);
  $("localVideo").srcObject = localStream;

  pc = new RTCPeerConnection({ iceServers:[{urls:"stun:stun.l.google.com:19302"}] });
  localStream.getTracks().forEach(t=> pc.addTrack(t, localStream));
  pc.ontrack = e => {
    const s=e.streams[0]; if(!s) return;
    s.getTracks().forEach(tr=>{
      if(tr.kind==="video"){ $("remoteVideo").srcObject=s; }
      if(tr.kind==="audio"){ remoteAudio.srcObject=s; }
    });
  };
  pc.onicecandidate = e => e.candidate && socket.emit("signal",{ roomId, data:e.candidate });

  socket.emit("join_room",{ roomId });

  if (role==="offerer"){
    const offer=await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("signal",{ roomId, data: pc.localDescription });
  }
}

$("hangup").onclick=()=>{
  if (roomId) socket.emit("hangup",{ roomId });
  endCall();
};
socket.on("peer_hangup", ()=> endCall());

function endCall(){
  $("call").classList.add("hidden");
  $("status").textContent="Call ended.";
  try{ pc && pc.close(); }catch{} pc=null;
  try{ localStream && localStream.getTracks().forEach(t=>t.stop()); }catch{}
  localStream=null; roomId=null; role=null;
}
