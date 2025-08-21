// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// --- simple in-memory stores (persist-with-json if you want) ---
const usersByPhone = new Map(); // phone -> { phone,name,passHash,token,profile:{gender,language,location,avatar}, createdAt }
const tokens = new Map();       // token -> phone
const resetCodes = new Map();   // phone -> { code, expiresAt }
const sockets = new Map();      // socketId -> token
const presence = new Map();     // token -> { socketId, free:true|false, lastSeen }

// queues for random calls
const queues = { audio: [], video: [] };

const PORT = process.env.PORT || 3000;

// Helpers
const norm = (s="") => String(s).trim().toLowerCase();
const oppGender = (a,b) =>
  (norm(a)==="male" && norm(b)==="female") || (norm(a)==="female" && norm(b)==="male");
const sameLang = (a,b) => norm(a) && norm(a)===norm(b);
const now = () => Date.now();

// Health
app.get("/healthz", (_,res)=>res.send("ok"));

// ---------- Auth APIs ----------
app.post("/api/signup", async (req,res)=>{
  try{
    const { phone, name, password } = req.body||{};
    if(!phone || !name || !password) return res.status(400).json({error:"All fields required"});
    if(usersByPhone.has(phone)) return res.status(409).json({error:"Phone already exists"});

    const passHash = await bcrypt.hash(password, 10);
    const token = uuidv4();
    const user = {
      phone, name, passHash, token,
      profile: { gender:"", language:"", location:"", avatar: getAutoAvatar(name) },
      createdAt: now()
    };
    usersByPhone.set(phone, user);
    tokens.set(token, phone);
    res.json({ ok:true });
  }catch(e){ res.status(500).json({error:"Signup failed"}); }
});

app.post("/api/login", async (req,res)=>{
  try{
    const { phone, password } = req.body||{};
    const u = usersByPhone.get(phone);
    if(!u) return res.status(401).json({error:"Invalid credentials"});
    const ok = await bcrypt.compare(password, u.passHash);
    if(!ok) return res.status(401).json({error:"Invalid credentials"});
    // new token each login
    const token = uuidv4();
    tokens.set(token, phone);
    u.token = token;
    res.json({ token, profile:u.profile, name:u.name, phone:u.phone });
  }catch(e){ res.status(500).json({error:"Login failed"}); }
});

// password reset (mock: code returned in response & logged)
app.post("/api/request-reset", (req,res)=>{
  const { phone } = req.body||{};
  const u = usersByPhone.get(phone);
  if(!u) return res.status(404).json({error:"Phone not found"});
  const code = String(Math.floor(100000 + Math.random()*900000));
  resetCodes.set(phone, { code, expiresAt: now()+5*60*1000 });
  console.log(`🔐 Reset code for ${phone}: ${code}`);
  // In production: send via SMS/Email
  res.json({ ok:true, code }); // return code only for demo
});

app.post("/api/confirm-reset", async (req,res)=>{
  const { phone, code, newPassword } = req.body||{};
  const entry = resetCodes.get(phone);
  if(!entry || entry.code!==code || entry.expiresAt<now())
    return res.status(400).json({error:"Invalid/expired code"});
  const u = usersByPhone.get(phone);
  if(!u) return res.status(404).json({error:"User not found"});
  u.passHash = await bcrypt.hash(newPassword,10);
  resetCodes.delete(phone);
  res.json({ ok:true });
});

app.post("/api/me", (req,res)=>{
  const { token } = req.body||{};
  const phone = tokens.get(token);
  if(!phone) return res.status(401).json({error:"Invalid token"});
  const u = usersByPhone.get(phone);
  res.json({ name:u.name, phone:u.phone, profile:u.profile });
});

app.post("/api/prefs", (req,res)=>{
  const { token, gender, language, location } = req.body||{};
  const phone = tokens.get(token);
  if(!phone) return res.status(401).json({error:"Invalid token"});
  const u = usersByPhone.get(phone);
  u.profile.gender = gender||"";
  u.profile.language = language||"";
  u.profile.location = location||"";
  if(!u.profile.avatar) u.profile.avatar = getAutoAvatar(u.name);
  res.json({ ok:true });
});

// ---------- Socket.IO ----------
io.on("connection", (socket)=>{
  socket.on("auth", ({token})=>{
    const phone = tokens.get(token);
    if(!phone) { socket.emit("auth_error",{error:"Invalid token"}); return; }
    sockets.set(socket.id, token);
    presence.set(token, { socketId:socket.id, free:true, lastSeen:now() });
    socket.emit("auth_ok");
    pushPresence();
  });

  socket.on("disconnect", ()=>{
    const token = sockets.get(socket.id);
    if(token){
      presence.delete(token);
      sockets.delete(socket.id);
      // also remove from any queues
      for(const m of Object.keys(queues)){
        const idx = queues[m].findIndex(t=>t===token);
        if(idx>=0) queues[m].splice(idx,1);
      }
      pushPresence();
    }
  });

  // Get online list
  socket.on("presence_get",()=> pushPresence());

  // Direct call to target
  socket.on("call_user", ({targetToken, mode})=>{
    const caller = sockets.get(socket.id);
    const callee = targetToken;
    if(!caller || !presence.has(caller) || !presence.has(callee)) return;

    if(!eligible(caller) || !eligible(callee)) {
      socket.emit("call_error",{error:"Both users must complete profile"}); return;
    }
    if(!oppositePair(caller, callee)) {
      socket.emit("call_error",{error:"Language or gender not compatible"}); return;
    }

    startRinging({caller, callee, mode});
  });

  // Random matchmaking
  socket.on("find_match", ({mode})=>{
    const seeker = sockets.get(socket.id);
    if(!seeker || !eligible(seeker)) return;
    // try find partner in queue
    const q = queues[mode];
    let partner = null;
    for(let i=0;i<q.length;i++){
      const cand = q[i];
      if(cand===seeker) continue;
      if(eligible(cand) && oppositePair(seeker,cand)){
        partner = cand; q.splice(i,1); break;
      }
    }
    if(partner) startRinging({caller:seeker, callee:partner, mode});
    else { queues[mode].push(seeker); io.to(presence.get(seeker).socketId).emit("queued",{mode}); }
  });

  socket.on("cancel_find", ({mode})=>{
    const t = sockets.get(socket.id);
    if(!t) return;
    const q = queues[mode];
    const idx = q.findIndex(x=>x===t);
    if(idx>=0) q.splice(idx,1);
  });

  // Signaling
  socket.on("signal", ({roomId, data})=>{
    socket.to(roomId).emit("signal",{data});
  });

  socket.on("call_accept", ({roomId})=>{
    // join room and notify
    socket.join(roomId);
    socket.to(roomId).emit("call_accepted");
  });

  socket.on("call_decline", ({roomId})=>{
    socket.to(roomId).emit("call_declined");
  });

  socket.on("hangup", ({roomId})=>{
    socket.to(roomId).emit("peer_hangup");
    endRoom(roomId);
  });
});

// ---- Ringing orchestration ----
const activeRings = new Map(); // roomId -> { caller, callee, timeout }
function startRinging({caller, callee, mode}){
  const roomId = uuidv4();
  const sCaller = presence.get(caller)?.socketId;
  const sCallee = presence.get(callee)?.socketId;
  if(!sCaller || !sCallee) return;

  // mark both busy
  presence.get(caller).free = false;
  presence.get(callee).free = false;
  pushPresence();

  const callerUser = getUserByToken(caller);
  const calleeUser = getUserByToken(callee);

  io.sockets.sockets.get(sCaller)?.join(roomId);
  io.to(sCaller).emit("outgoing_call", { roomId, mode, to: { name: calleeUser.name, avatar: calleeUser.profile.avatar } });

  io.to(sCallee).emit("incoming_call", { roomId, mode, from: { name: callerUser.name, avatar: callerUser.profile.avatar } });

  const timeout = setTimeout(()=>{
    io.to(sCaller).emit("call_timeout");
    io.to(sCallee).emit("call_missed");
    endRoom(roomId);
  }, 30_000);

  activeRings.set(roomId,{caller, callee, timeout});
}

function endRoom(roomId){
  const r = activeRings.get(roomId);
  if(!r) return;
  clearTimeout(r.timeout);
  // free both
  const pc = presence.get(r.caller); if(pc) pc.free = true;
  const pp = presence.get(r.callee); if(pp) pp.free = true;
  activeRings.delete(roomId);
  pushPresence();
}

function pushPresence(){
  const list = [];
  for(const [token, p] of presence.entries()){
    const u = getUserByToken(token);
    list.push({ token, name:u.name, email:u.phone, prefs:u.profile, avatar:u.profile.avatar, free:p.free });
  }
  io.emit("presence", list);
}

function getUserByToken(token){
  const phone = tokens.get(token);
  return usersByPhone.get(phone);
}

function eligible(token){
  const u = getUserByToken(token);
  const pf = u?.profile||{};
  return !!(pf.gender && pf.language); // location optional
}

function oppositePair(aToken, bToken){
  const a = getUserByToken(aToken).profile;
  const b = getUserByToken(bToken).profile;
  return oppGender(a.gender,b.gender) && sameLang(a.language,b.language);
}

// very simple generated avatar
function getAutoAvatar(name="User"){
  const initial = encodeURIComponent((name||"U").trim()[0]?.toUpperCase() || "U");
  return `https://api.dicebear.com/7.x/thumbs/svg?seed=${initial}`;
}

server.listen(PORT, ()=> console.log(`✅ FriendApp running on port ${PORT}`));

// -------- Start server ----------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("✅ FriendApp running on port", PORT);
});