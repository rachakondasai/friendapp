import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json());

// Static site (three pages)
app.use(express.static("public", { extensions: ["html"] }));

// Health for Render
app.get("/healthz", (req, res) => res.status(200).send("ok"));

// Root -> login (cheap, no loops)
app.get("/", (req, res) => res.redirect("/login"));

// ---------- Memory stores ----------
const usersByPhone = new Map();      // phone -> { phone, name, password, gender, language, location, avatar }
const socketsByPhone = new Map();    // phone -> socketId
const phoneBySocket = new Map();     // socketId -> phone
const queues = { audio: [], video: [] };   // waiting users

// helpers
const norm = (v="") => String(v).trim().toLowerCase();
const oppGender = (a,b) => {
  const ga = norm(a.gender), gb = norm(b.gender);
  if (!ga || !gb) return true; // if not set, allow
  return (ga === "male" && gb === "female") || (ga === "female" && gb === "male");
};
const sameLang = (a,b) => !a.language || !b.language ? true : norm(a.language) === norm(b.language);

// ---------- REST: auth & prefs ----------
app.post("/api/signup", (req, res) => {
  const { phone, name, password } = req.body || {};
  if (!phone || !name || !password) return res.status(400).json({ error: "All fields required" });
  if (usersByPhone.has(phone)) return res.status(409).json({ error: "Phone already exists" });
  usersByPhone.set(phone, {
    phone, name, password,
    gender: "", language: "", location: "",
    avatar: "/avatars/neutral.png"
  });
  res.json({ ok: true });
});

app.post("/api/login", (req, res) => {
  const { phone, password } = req.body || {};
  const u = usersByPhone.get(phone);
  if (!u || u.password !== password) return res.status(401).json({ error: "Invalid credentials" });
  res.json({ ok: true, profile: { phone: u.phone, name: u.name } });
});

app.post("/api/prefs", (req, res) => {
  const { phone, gender, language, location } = req.body || {};
  const u = usersByPhone.get(phone);
  if (!u) return res.status(404).json({ error: "User not found" });

  if (gender !== undefined) u.gender = gender;
  if (language !== undefined) u.language = language;
  if (location !== undefined) u.location = location;

  if (norm(u.gender) === "male")   u.avatar = "/avatars/male.png";
  if (norm(u.gender) === "female") u.avatar = "/avatars/female.png";
  res.json({ ok: true });
});

app.post("/api/me", (req, res) => {
  const { phone } = req.body || {};
  const u = usersByPhone.get(phone);
  if (!u) return res.status(404).json({ error: "Not found" });
  res.json({
    profile: { name: u.name, phone: u.phone, avatar: u.avatar },
    prefs: { gender: u.gender, language: u.language, location: u.location }
  });
});

app.get("/api/online", (req, res) => {
  const list = [...usersByPhone.values()]
    .filter(u => socketsByPhone.has(u.phone))
    .map(u => ({ phone: u.phone, name: u.name, avatar: u.avatar, prefs: { gender: u.gender, language: u.language, location: u.location } }));
  res.json({ online: list });
});

// ---------- Socket.IO ----------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET","POST"] } });

function broadcastPresence() {
  const list = [...usersByPhone.values()]
    .filter(u => socketsByPhone.has(u.phone))
    .map(u => ({ phone: u.phone, name: u.name, avatar: u.avatar, prefs: { gender: u.gender, language: u.language, location: u.location } }));
  io.emit("presence", list);
}

function dequeue(mode, seeker) {
  const q = queues[mode];
  for (let i=0;i<q.length;i++) {
    const cand = q[i];
    if (cand.phone === seeker.phone) continue;
    if (oppGender(seeker, cand) && sameLang(seeker, cand)) {
      q.splice(i,1);
      return cand;
    }
  }
  return null;
}

io.on("connection", (socket) => {
  socket.on("auth", ({ phone }) => {
    const u = usersByPhone.get(phone);
    if (!u) { socket.emit("auth_error", { error: "Unknown user" }); return; }
    socketsByPhone.set(phone, socket.id);
    phoneBySocket.set(socket.id, phone);
    socket.emit("auth_ok");
    broadcastPresence();
  });

  socket.on("presence_get", () => broadcastPresence());

  socket.on("find_match", ({ mode, phone }) => {
    const u = usersByPhone.get(phone);
    if (!u) return;
    const seeker = { phone, gender:u.gender, language:u.language, location:u.location, socketId: socket.id };
    const partner = dequeue(mode, seeker);
    if (partner) {
      const roomId = uuidv4();
      const offerer = Math.random() < 0.5 ? seeker : partner;
      const answerer = offerer.phone === seeker.phone ? partner : seeker;

      io.to(offerer.socketId).emit("outgoing_call", { roomId, mode, to: usersByPhone.get(answerer.phone) });
      io.to(answerer.socketId).emit("incoming_call", { roomId, mode, from: usersByPhone.get(offerer.phone) });
    } else {
      queues[mode].push(seeker);
      socket.emit("queued", { mode });
    }
  });

  socket.on("cancel_find", ({ mode, phone }) => {
    const q = queues[mode] || [];
    const idx = q.findIndex(x => x.phone === phone);
    if (idx >= 0) q.splice(idx,1);
  });

  socket.on("call_accept", ({ roomId, phone }) => {
    io.to(socket.id).emit("call_accepted", { roomId, role: "answerer" });
  });

  socket.on("call_decline", ({ roomId }) => {
    socket.broadcast.emit("call_declined", { roomId });
  });

  socket.on("cancel_invite", ({ roomId }) => {
    socket.broadcast.emit("call_cancelled", { roomId });
  });

  socket.on("signal", ({ roomId, data }) => {
    socket.to(roomId).emit("signal", { data });
  });

  socket.on("join_room", ({ roomId }) => {
    socket.join(roomId);
  });

  socket.on("hangup", ({ roomId }) => {
    socket.to(roomId).emit("peer_hangup");
  });

  socket.on("disconnect", () => {
    const phone = phoneBySocket.get(socket.id);
    if (phone) {
      socketsByPhone.delete(phone);
      phoneBySocket.delete(socket.id);
      // remove from queues
      for (const m of Object.keys(queues)) {
        const i = queues[m].findIndex(e => e.phone === phone);
        if (i >= 0) queues[m].splice(i,1);
      }
    }
    broadcastPresence();
  });
});

// ---------- Start ----------
const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ FriendApp running on port ${PORT}`);
});
