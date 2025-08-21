import { getToken, logout, me } from '/ui.js';

const $ = id => document.getElementById(id);
const token = getToken(); if (!token) location.href = '/login';

$("logout").onclick = () => logout();

const socket = io();
socket.on('connect', () => socket.emit('auth', { token }));
socket.on('auth_ok', () => socket.emit('presence_get'));

socket.on('presence', list => {
  const box = $("online"); box.innerHTML='';
  list.forEach(u => {
    const d = document.createElement('div');
    d.className = 'item';
    d.innerHTML = `<img class="avatar" src="${u.avatar}"><div class="grow"><b>${u.name}</b><div style="opacity:.7;font-size:12px">${u.prefs.language} • ${u.prefs.gender}</div></div><div>📞</div>`;
    d.onclick = () => socket.emit('call_user', { targetId: u.id, mode: 'video' });
    box.appendChild(d);
  });
});

let roomId=null, role=null, mode=null;
let pc=null, dc=null, localStream=null;
let micOn=true, camOn=true;
let callStart=0, tInt=null;

const toneOut = $("tone_out"), toneIn = $("tone_in");
const remoteAudio = $("remoteAudio");

function timerStart(){
  callStart = Date.now(); clearInterval(tInt);
  tInt = setInterval(() => {
    const s = Math.floor((Date.now()-callStart)/1000);
    const mm = String(Math.floor(s/60)).padStart(2,'0');
    const ss = String(s%60).padStart(2,'0');
    $("timer").textContent = `${mm}:${ss}`;
  },1000);
}
function timerStop(){ clearInterval(tInt); $("timer").textContent = "00:00"; }
function stopTones(){ [toneOut, toneIn].forEach(a=>{try{a.pause(); a.currentTime=0;}catch{}}); }

socket.on('queued', ({mode}) => $("status").textContent = `Waiting for ${mode} partner…`);

socket.on('incoming_call', ({roomId:rid, mode:m, from}) => {
  roomId=rid; role='answerer'; mode=m;
  $("status").textContent = `Incoming ${m} from ${from.name}`;
  try{ toneIn.currentTime=0; toneIn.play(); }catch{}
  // auto-accept after user click? implement UI; here accept on any video click:
  const ok = confirm(`Accept ${m} call from ${from.name}?`);
  if (ok) socket.emit('call_accept', { roomId }); else socket.emit('call_decline', { roomId });
});

socket.on('outgoing_call', ({roomId:rid, mode:m, to}) => {
  roomId=rid; role='offerer'; mode=m;
  $("status").textContent = `Calling ${to.name} (${m})…`;
  try{ toneOut.currentTime=0; toneOut.play(); }catch{}
});

socket.on('call_timeout', ()=>{ stopTones(); $("status").textContent="No answer."; });
socket.on('call_cancelled',()=>{ stopTones(); $("status").textContent="Call cancelled."; });
socket.on('call_declined', ()=>{ stopTones(); $("status").textContent="Declined."; });

socket.on('call_accepted', async ({roomId:rid, role:r, mode:m}) => {
  stopTones(); roomId=rid; role=r; mode=m; await startCall();
});

socket.on('signal', async ({data}) => {
  if (!pc) return;
  if (data.type === 'offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data));
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    socket.emit('signal', { roomId, data: pc.localDescription });
  } else if (data.type === 'answer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data));
  } else if (data.candidate) {
    try { await pc.addIceCandidate(data); } catch {}
  }
});

$("btn_audio").onclick = () => { socket.emit('find_match', { mode:'audio' }); $("status").textContent='Searching audio…'; };
$("btn_video").onclick = () => { socket.emit('find_match', { mode:'video' }); $("status").textContent='Searching video…'; };
$("btn_cancel").onclick=  () => socket.emit('cancel_find', { mode });

$("btn_mic").onclick = () => { micOn=!micOn; localStream?.getAudioTracks().forEach(t=>t.enabled=micOn); };
$("btn_cam").onclick = () => { camOn=!camOn; localStream?.getVideoTracks().forEach(t=>t.enabled=camOn); };
$("btn_hang").onclick = () => { socket.emit('hangup', { roomId }); endCall('You hung up'); };

async function startCall(){
  $("status").textContent = `In ${mode} call`;
  timerStart();

  const constraints = mode==='audio' ? { audio:true, video:false } : { audio:true, video:true };
  localStream = await navigator.mediaDevices.getUserMedia(constraints);
  $("localVideo").srcObject = localStream;

  const ice = [{ urls:'stun:stun.l.google.com:19302' }];
  // optional TURN via env on Render: expose in client if required

  pc = new RTCPeerConnection({ iceServers: ice });
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.onicecandidate = e => e.candidate && socket.emit('signal',{ roomId, data:e.candidate });
  pc.ontrack = e => {
    const s = e.streams[0]; if (!s) return;
    s.getTracks().forEach(tr => {
      if (tr.kind === 'video') { $("remoteVideo").srcObject = s; }
      if (tr.kind === 'audio') { remoteAudio.srcObject = s; }
    });
  };

  if (role === 'offerer') { dc = pc.createDataChannel('chat'); } else { pc.ondatachannel = ev => (dc = ev.channel); }

  if (role === 'offerer') {
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    socket.emit('signal', { roomId, data: pc.localDescription });
  }
}

function endCall(msg){
  timerStop(); stopTones();
  try { dc && dc.close(); } catch {}
  try { pc && pc.close(); } catch {}
  if (localStream) try { localStream.getTracks().forEach(t=>t.stop()); } catch {}
  localStream = pc = dc = null; roomId = role = mode = null;
  $("status").textContent = msg || 'Call ended';
  $("localVideo").srcObject = null; $("remoteVideo").srcObject = null;
}

socket.on('peer_hangup', ()=> endCall('Peer hung up'));
