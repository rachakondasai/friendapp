// dash.js
const phone = localStorage.getItem("phone");
if (!phone) location.href = "/login";

const $ = id => document.getElementById(id);
const api = async (p, b) => {
  const r = await fetch(p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(b || {})
  });
  if (!r.ok) throw new Error((await r.json()).error || "Request failed");
  return r.json();
};

let me = null, myPrefs = null;
let socket = null, mode = null, roomId = null, pc = null, dc = null, localStream = null, timerId = null, startAt = 0;
let micOn = true, camOn = true;
let currentPeerAvatar = "";

(async function boot() {
  const m = await api("/api/me", { phone });
  me = m.profile; myPrefs = m.prefs;
  if (!myPrefs?.gender || !myPrefs?.language) { location.href = "/prefs"; return; }
  $("coins").textContent = `Coins: ${me.coins || 0}`;
  $("btnRecharge").style.display = (myPrefs.gender === "male") ? "inline-block" : "none";

  await refreshOnline();
  await refreshHistory();

  socket = io();
  socket.on("connect", () => socket.emit("auth", { phone }));
  socket.on("presence", () => refreshOnline());

  socket.on("incoming_call", ({ roomId: rid, mode: m, from }) => {
    roomId = rid; mode = m;
    currentPeerAvatar = from?.avatar || "";
    $("ringAvatar").src = currentPeerAvatar;
    showRing(`Incoming ${mode} call from ${from?.name || from?.phone}`);
    $("accept").onclick = () => socket.emit("call_accept", { roomId });
    $("decline").onclick = () => socket.emit("call_decline", { roomId });
  });

  socket.on("outgoing_call", ({ roomId: rid, mode: m, to }) => {
    roomId = rid; mode = m;
    currentPeerAvatar = to?.avatar || "";
    $("ringAvatar").src = currentPeerAvatar;
    showRing(`Calling ${to?.name || to?.phone}…`);
    $("cancel").onclick = () => socket.emit("cancel_invite", { roomId });
  });

  socket.on("call_accepted", async ({ roomId: rid, role, mode: m }) => {
    roomId = rid; mode = m; hideRing();
    $("peerAvatar").src = currentPeerAvatar;
    await startCall(role, mode);
  });

  socket.on("call_declined", () => endCall("Declined"));
  socket.on("call_cancelled", () => endCall("Cancelled"));
  socket.on("peer_hangup", () => endCall("Peer hung up"));
  socket.on("call_error", (e) => endCall(e.error || "Call error"));

  socket.on("signal", async ({ data }) => {
    if (!pc) return;
    if (data.type === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(data));
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      socket.emit("signal", { roomId, data: pc.localDescription });
    } else if (data.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(data));
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data); } catch {}
    }
  });

  // UI events
  $("btnAudio").onclick = () => beginRandom("audio");
  $("btnVideo").onclick = () => beginRandom("video");
  $("btnCancel").onclick = () => { if (roomId) socket.emit("cancel_invite", { roomId }); $("status").textContent = "Cancelled."; };
  $("btnLogout").onclick = () => { localStorage.clear(); location.href = "/login"; };
  $("btnRecharge").onclick = async () => {
    const amount = prompt("Enter pack (₹100, ₹200, ₹500, ₹1000):");
    if (!amount) return;
    try {
      await api("/api/recharge-request", { phone, amount: Number(amount) });
      alert("Request sent. Admin will approve.");
    } catch (e) { alert(e.message); }
  };

  $("mic").onclick = () => { micOn = !micOn; localStream?.getAudioTracks().forEach(t => t.enabled = micOn); };
  $("cam").onclick = () => { camOn = !camOn; localStream?.getVideoTracks().forEach(t => t.enabled = camOn); };
  $("hang").onclick = () => { socket.emit("hangup", { roomId }); endCall("You hung up"); };
  $("chatSend").onclick = () => {
    const v = $("chatInput").value.trim();
    if (!v || !dc || dc.readyState !== "open") return;
    dc.send(v); addChat("You", v); $("chatInput").value = "";
  };
})();

async function refreshOnline() {
  const j = await api("/api/online", {});
  $("online").innerHTML = "";
  j.online
    .filter(u => u.phone !== phone)
    .forEach(u => {
      const el = document.createElement("div");
      el.className = "row item";
      el.innerHTML = `
        <img src="${u.avatar || ""}" class="avatar" alt="">
        <div class="grow">
          <div><b>${u.name}</b> <span class="muted">• ${u.prefs?.language || "-"}</span></div>
          <div class="muted small">${u.prefs?.location || ""}</div>
        </div>
        <button class="small" data-phone="${u.phone}">Call</button>`;
      el.querySelector("button").onclick = () => beginRandom("video"); // keep same pipeline
      $("online").appendChild(el);
    });
}

async function refreshHistory() {
  const j = await api("/api/history", { phone });
  $("history").innerHTML = "";
  j.history.forEach(h => {
    const mins = Math.round(h.ms / 60000);
    const who = h.aPhone === phone ? h.bPhone : h.aPhone;
    const el = document.createElement("div");
    el.className = "row item";
    el.innerHTML = `<div class="grow">${h.mode} • ${new Date(h.startedAt).toLocaleString()} • ${mins} min • with ${who}</div>`;
    $("history").appendChild(el);
  });
}

function beginRandom(m) {
  mode = m;
  if (myPrefs.gender === "male" && (me.coins || 0) < 100) {
    $("status").textContent = "Low balance. Please recharge first.";
    return;
  }
  $("status").textContent = `Searching ${m} partner…`;
  socket.emit("find_match", { phone, mode: m });
}

function showRing(t) {
  $("ringText").textContent = t;
  $("ring").classList.remove("hidden");
}
function hideRing() { $("ring").classList.add("hidden"); }

async function startCall(role, m) {
  hideRing();
  $("callBox").classList.remove("hidden");
  $("status").textContent = "In call…";
  startAt = Date.now();
  updateTimer(); timerId = setInterval(updateTimer, 1000);

  const constraints = m === "audio" ? { audio: true, video: false } : { audio: true, video: true };
  localStream = await navigator.mediaDevices.getUserMedia(constraints);
  $("local").srcObject = localStream;

  pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.onicecandidate = e => e.candidate && socket.emit("signal", { roomId, data: e.candidate });
  pc.ontrack = (ev) => {
    const s = ev.streams[0]; if (!s) return;
    s.getTracks().forEach(tr => {
      if (tr.kind === "video") $("remote").srcObject = s;
      if (tr.kind === "audio") $("remoteAudio").srcObject = s;
    });
  };

  if (role === "offerer") {
    dc = pc.createDataChannel("chat");
    wireDC(dc);
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    socket.emit("signal", { roomId, data: pc.localDescription });
  } else {
    pc.ondatachannel = (ev) => wireDC(ev.channel);
  }
}

function wireDC(ch) {
  dc = ch;
  dc.onmessage = (ev) => addChat("Friend", ev.data);
  addChat("system", "Chat connected");
}

function addChat(who, msg) {
  const line = document.createElement("div");
  line.innerHTML = `<b>${who}:</b> ${msg}`;
  $("chatLog").appendChild(line);
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
}

function updateTimer() {
  const s = Math.floor((Date.now() - startAt) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  $("timer").textContent = `${mm}:${ss}`;
}

function endCall(note) {
  try { clearInterval(timerId); } catch {}
  $("callBox").classList.add("hidden");
  $("status").textContent = note || "Call ended";
  try { dc && dc.close(); } catch {}
  try { pc && pc.close(); } catch {}
  try { localStream && localStream.getTracks().forEach(t => t.stop()); } catch {}
  dc = pc = localStream = null; roomId = null;
  api("/api/me", { phone }).then(x => { me = x.profile; $("coins").textContent = `Coins: ${me.coins || 0}`; });
  refreshHistory();
}
