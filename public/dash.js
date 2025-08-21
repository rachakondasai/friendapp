const phone = localStorage.getItem("phone");
const name  = localStorage.getItem("name");
if (!phone) location.href="/login";

const $ = id => document.getElementById(id);

// Profile header
$("me_name").textContent  = name || "User";
$("me_phone").textContent = phone;

// Load me (emoji name + avatar + prefs + coins)
(async ()=>{
  try{
    const r=await fetch("/api/me",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phone})});
    const j=await r.json();
    $("me_avatar").src = j.profile.avatar;
    $("me_name").textContent = j.profile.name;
    $("me_coins").textContent = j.wallet?.coins ?? 0;
    $("gender").value   = j.prefs.gender   || "";
    $("language").value = j.prefs.language || "";
    $("location").value = j.prefs.location || "";

    // Wallet view gating
    const g = (j.prefs.gender||"").toLowerCase();
    if (g==="male"){ $("wallet_male").classList.remove("hide"); $("wallet_female").classList.add("hide"); }
    else if (g==="female"){ $("wallet_female").classList.remove("hide"); $("wallet_male").classList.add("hide"); }
  }catch{}
})();

$("logout").onclick=()=>{ localStorage.clear(); location.href="/login"; };

$("save").onclick=async()=>{
  $("status").textContent="Saving...";
  const body={ phone, gender:$("gender").value, language:$("language").value, location:$("location").value };
  const r=await fetch("/api/prefs",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const j=await r.json();
  $("status").textContent = r.ok ? "Saved." : (j.error||"Save failed");
  // refresh me (for avatar + wallet gating)
  const r2=await fetch("/api/me",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phone})});
  const m=await r2.json();
  $("me_avatar").src = m.profile.avatar;
  $("me_name").textContent = m.profile.name;
  const g = (m.prefs.gender||"").toLowerCase();
  if (g==="male"){ $("wallet_male").classList.remove("hide"); $("wallet_female").classList.add("hide"); }
  else if (g==="female"){ $("wallet_female").classList.remove("hide"); $("wallet_male").classList.add("hide"); }
};

// Recharge (male)
document.querySelectorAll(".pack").forEach(btn=>{
  btn.onclick = async ()=>{
    const pack = btn.dataset.pack;
    const r=await fetch("/api/recharge",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phone,pack})});
    const j=await r.json();
    $("status").textContent = r.ok? `Recharge success: +${j.coinsAdded} coins` : (j.error||"Recharge failed");
    if (r.ok) $("me_coins").textContent = j.balance;
  };
});

// Redeem (female)
$("redeem").onclick = async ()=>{
  const amount = Number($("rd_amount").value);
  const upi = $("rd_upi").value.trim();
  const r=await fetch("/api/redeem",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phone,amount,upi})});
  const j=await r.json();
  $("status").textContent = r.ok? `Redeem request placed. New balance: ${j.balance}` : (j.error||"Redeem failed");
  if (r.ok) $("me_coins").textContent = j.balance;
};

// Socket + presence
const socket = io();
socket.on("connect", ()=> socket.emit("auth",{ phone }));
socket.on("auth_ok", ()=> { socket.emit("presence_get"); refreshOnline(); });

socket.on("presence", list => renderOnline(list));
socket.on("status", ({text})=> $("info").textContent=text);

// Render online users
function renderOnline(list){
  const box=$("online"); box.innerHTML="";
  list.filter(u=>u.phone!==phone).forEach(u=>{
    const emoji = (u.prefs.gender||"").toLowerCase()==="male"?"♂️":(u.prefs.gender||"").toLowerCase()==="female"?"♀️":"🙂";
    const busy = u.inCall ? " • in call" : (u.ringing ? " • ringing" : "");
    const row=document.createElement("div");
    row.className="row";
    row.innerHTML=`
      <img src="${u.avatar}" class="avatar sm">
      <div class="flex1">
        <div class="bold">${u.name} ${emoji}</div>
        <div class="muted">${u.prefs.language||"-"} • ${u.prefs.gender||"-"}${busy}</div>
      </div>
    `;
    // (No direct-call button by request; use Random to auto‑match best opposite gender)
    box.appendChild(row);
  });
}

async function refreshOnline(){
  const r=await fetch("/api/online"); const j=await r.json(); renderOnline(j.online);
}

// Random find
function find(mode){
  $("info").textContent=`Looking for ${mode} partner...`;
  socket.emit("find_match",{ mode, phone });
}
$("randAudio").onclick=()=> find("audio");
$("randVideo").onclick=()=> find("video");
$("cancel").onclick =()=> $("info").textContent="Cancelled.";

/* ----------------------------- WebRTC + Call ---------------------------- */
let pc=null, localStream=null, role=null, roomId=null, timer=null, startMs=0, peerPic="/avatars/neutral.png";

const remoteAudio = $("remoteAudio");

socket.on("outgoing_call",({roomId:rid,mode,to})=>{
  role="offerer"; roomId=rid; peerPic=to?.avatar||"/avatars/neutral.png";
  $("peer_pic").src = peerPic;
  $("peer_label").textContent = (to?.name||"Friend");
  $("info").textContent=`Calling ${to?.name||""}...`;
  startCall(mode);
});
socket.on("incoming_call",({roomId:rid,mode,from})=>{
  role="answerer"; roomId=rid; peerPic=from?.avatar||"/avatars/neutral.png";
  $("peer_pic").src = peerPic;
  $("peer_label").textContent = (from?.name||"Friend");
  $("info").textContent=`Incoming ${mode} call from ${from?.name||""}...`;
  // auto-accept for now
  socket.emit("call_accept",{ roomId, phone });
  startCall(mode);
});
socket.on("call_declined",()=> $("info").textContent="Declined.");
socket.on("call_cancelled",()=> $("info").textContent="Cancelled.");

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

// call summary (coins earned for female)
socket.on("call_summary", ({durationMs, coinsAdded, balance})=>{
  const mm=String(Math.floor(durationMs/60000)).padStart(2,"0");
  const ss=String(Math.floor(durationMs/1000)%60).padStart(2,"0");
  $("summary").textContent = `Duration ${mm}:${ss}` + (coinsAdded? ` • +${coinsAdded} coins` : "");
  if (typeof balance==="number") $("me_coins").textContent = balance;
});

async function startCall(mode){
  $("call").classList.remove("hide");
  $("summary").textContent="";
  $("me_pic").src = $("me_avatar").src;

  const audioOnly = mode==="audio";
  $("videoWrap").style.display = audioOnly ? "none" : "grid";

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

  // timer
  startMs=Date.now();
  clearInterval(timer);
  timer=setInterval(()=>{
    const d=Date.now()-startMs;
    const mm=String(Math.floor(d/60000)).padStart(2,"0");
    const ss=String(Math.floor(d/1000)%60).padStart(2,"0");
    $("timer").textContent = `${mm}:${ss}`;
  }, 1000);

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
  clearInterval(timer);
  $("timer").textContent="00:00";
  $("call").classList.add("hide");
  try{ pc && pc.close(); }catch{} pc=null;
  try{ localStream && localStream.getTracks().forEach(t=>t.stop()); }catch{}
  localStream=null; roomId=null; role=null;
}
