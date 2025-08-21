import express from "express";
import http from "http";
import { Server } from "socket.io";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static("public"));

// ===== In-memory stores (replace with DB in production) =====
const usersByPhone = new Map();     // phone -> { id, phone, name, passHash, gender, language, location }
const tokens = new Map();           // token -> userId
const socketsByUser = new Map();    // userId -> socket.id
const usersBySocket = new Map();    // socket.id -> userId

// presence
const online = new Set();           // userId online

// ===== Helpers =====
const normalize = (s="") => String(s).trim().toLowerCase();
const oppositeGender = (a,b) =>
  (a==="male" && b==="female") || (a==="female" && b==="male");

// ===== API =====

// signup: {name, phone, password}
app.post("/api/signup", async (req,res)=>{
  try{
    const { name, phone, password } = req.body || {};
    if(!name || !phone || !password) return res.status(400).json({error:"name, phone, password required"});
    if(usersByPhone.has(phone)) return res.status(409).json({error:"phone already registered"});

    const passHash = await bcrypt.hash(password, 10);    // ← hash INSIDE handler
    const user = { id: uuidv4(), name, phone, passHash, gender:"", language:"", location:"" };
    usersByPhone.set(phone, user);
    return res.json({ ok:true, message:"account created" });
  }catch(e){
    return res.status(500).json({error:"server error"});
  }
});

// login: {phone, password}
app.post("/api/login", async (req,res)=>{
  try{
    const { phone, password } = req.body || {};
    const user = usersByPhone.get(phone);
    if(!user) return res.status(401).json({error:"invalid credentials"});
    const ok = await bcrypt.compare(password, user.passHash);
    if(!ok) return res.status(401).json({error:"invalid credentials"});
    const token = uuidv4();
    tokens.set(token, user.id);
    return res.json({ token, profile:{ id:user.id, name:user.name, phone:user.phone, gender:user.gender, language:user.language, location:user.location }});
  }catch(e){
    return res.status(500).json({error:"server error"});
  }
});

// save prefs: {token, gender, language, location}
app.post("/api/prefs", (req,res)=>{
  const { token, gender, language, location } = req.body || {};
  const uid = tokens.get(token);
  if(!uid) return res.status(401).json({error:"invalid token"});
  const user = [...usersByPhone.values()].find(u=>u.id===uid);
  if(!user) return res.status(401).json({error:"invalid token"});
  user.gender = gender || user.gender;
  user.language = language || user.language;
  user.location = location || user.location;
  res.json({ ok:true });
});

// whoami
app.post("/api/me", (req,res)=>{
  const { token } = req.body || {};
  const uid = tokens.get(token);
  if(!uid) return res.status(401).json({error:"invalid token"});
  const u = [...usersByPhone.values()].find(x=>x.id===uid);
  res.json({ profile:{ id:u.id, name:u.name, phone:u.phone, gender:u.gender, language:u.language, location:u.location }});
});

// ===== Socket.io (auth + presence + simple random matching) =====
io.on("connection",(socket)=>{
  socket.on("auth", ({ token })=>{
    const uid = tokens.get(token);
    if(!uid) return socket.emit("auth_error", {error:"invalid token"});
    socketsByUser.set(uid, socket.id);
    usersBySocket.set(socket.id, uid);
    online.add(uid);
    socket.emit("auth_ok");
    broadcastPresence();
  });

  socket.on("find_match", ({ mode })=>{
    const uid = usersBySocket.get(socket.id);
    if(!uid) return;
    const me = [...usersByPhone.values()].find(u=>u.id===uid);
    if(!me || !me.gender || !me.language) {
      socket.emit("match_error",{error:"set language & gender first"});
      return;
    }
    // pick an opposite-gender online user with same language (and not self)
    const candidates = [...online]
      .filter(id => id!==uid)
      .map(id => [...usersByPhone.values()].find(u=>u.id===id))
      .filter(u => u && oppositeGender(normalize(me.gender), normalize(u.gender)) &&
                   normalize(me.language) === normalize(u.language));

    if(candidates.length===0){
      socket.emit("queued",{mode});
      return;
    }
    const partner = candidates[Math.floor(Math.random()*candidates.length)];
    // start a call — just tell both sides to create an RTCPeerConnection
    const roomId = uuidv4();
    const offererId = Math.random()<0.5 ? uid : partner.id;
    const answererId = offererId===uid ? partner.id : uid;

    io.to(socketsByUser.get(offererId)).emit("match_found",{roomId,role:"offerer",mode});
    io.to(socketsByUser.get(answererId)).emit("match_found",{roomId,role:"answerer",mode});
  });

  socket.on("signal", ({ roomId, data })=>{
    socket.to(roomId).emit("signal",{data});
  });

  socket.on("hangup", ({ roomId })=>{
    socket.to(roomId).emit("peer_hangup");
  });

  socket.on("disconnect", ()=>{
    const uid = usersBySocket.get(socket.id);
    if(uid){
      online.delete(uid);
      socketsByUser.delete(uid);
      usersBySocket.delete(socket.id);
      broadcastPresence();
    }
  });

  socket.on("join_room", ({ roomId })=>{
    socket.join(roomId);
  });
});

function broadcastPresence(){
  const arr = [...online].map(id => {
    const u = [...usersByPhone.values()].find(x=>x.id===id);
    return { id:u.id, name:u.name, phone:u.phone, gender:u.gender, language:u.language };
  });
  io.emit("presence", arr);
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", ()=>console.log(`✅ FriendApp running on port ${PORT}`));
