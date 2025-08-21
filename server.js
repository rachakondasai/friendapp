import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

/* ------------------------------------------------
   App + Static + Health
-------------------------------------------------*/
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public", { extensions: ["html"] }));
app.get("/healthz", (req, res) => res.status(200).send("ok"));
app.get("/", (req, res) => res.redirect("/login"));

/* ------------------------------------------------
   In‑memory stores (simple demo)
-------------------------------------------------*/
const usersByPhone = new Map();      // phone -> user
const socketsByPhone = new Map();    // phone -> socketId
const phoneBySocket = new Map();     // socketId -> phone
const status = new Map();            // phone -> { inCall:boolean, ringing:boolean }

const norm = s => String(s || "").trim().toLowerCase();
const isOpp = (a, b) =>
  (norm(a.gender) === "male" && norm(b.gender) === "female") ||
  (norm(a.gender) === "female" && norm(b.gender) === "male");

const sameLang = (a, b) =>
  !a.language || !b.language ? true : norm(a.language) === norm(b.language);

const setAvail = (phone, patch) => {
  const curr = status.get(phone) || { inCall: false, ringing: false };
  status.set(phone, { ...curr, ...patch });
};

/* ------------------------------------------------
   REST: Auth, Reset, Prefs
-------------------------------------------------*/
app.post("/api/signup", (req, res) => {
  const { phone, name, password } = req.body || {};
  if (!phone || !name || !password) return res.status(400).json({ error: "All fields required" });
  if (usersByPhone.has(phone)) return res.status(409).json({ error: "Phone already exists" });

  usersByPhone.set(phone, {
    phone, name, password,
    gender: "", language: "", location: "",
    avatar: "/avatars/neutral.png"
  });

  console.log(`👤 SIGNUP phone=${phone} name=${name}`);
  return res.json({ ok: true });
});

app.post("/api/login", (req, res) => {
  const { phone, password } = req.body || {};
  const u = usersByPhone.get(phone);
  if (!u || u.password !== password) return res.status(401).json({ error: "Invalid credentials" });

  console.log(`✅ LOGIN phone=${phone} name=${u.name}`);
  return res.json({ ok: true, profile: { phone: u.phone, name: u.name } });
});

// Simple reset: phone + newPassword (no OTP in this demo)
app.post("/api/reset", (req, res) => {
  const { phone, newPassword } = req.body || {};
  const u = usersByPhone.get(phone);
  if (!u) return res.status(404).json({ error: "User not found" });
  if (!newPassword) return res.status(400).json({ error: "New password required" });
  u.password = newPassword;
  console.log(`🔑 RESET password phone=${phone}`);
  return res.json({ ok: true });
});

app.post("/api/prefs", (req, res) => {
  const { phone, gender, language, location } = req.body || {};
  const u = usersByPhone.get(phone);
  if (!u) return res.status(404).json({ error: "User not found" });

  if (gender !== undefined) u.gender = gender;
  if (language !== undefined) u.language = language;
  if (location !== undefined) u.location = location;

  // auto avatar by gender
  const g = norm(u.gender);
  if (g === "male") u.avatar = "/avatars/male.png";
  else if (g === "female") u.avatar = "/avatars/female.png";
  else u.avatar = "/avatars/neutral.png";

  console.log(`🛠️ PREFS phone=${phone} gender=${u.gender} lang=${u.language} loc=${u.location}`);
  return res.json({ ok: true });
});

app.post("/api/me", (req, res) => {
  const { phone } = req.body || {};
  const u = usersByPhone.get(phone);
  if (!u) return res.status(404).json({ error: "Not found" });
  const emoji = norm(u.gender) === "male" ? "♂️" : norm(u.gender) === "female" ? "♀️" : "🙂";
  return res.json({
    profile: { name: `${u.name} ${emoji}`, phone: u.phone, avatar: u.avatar },
    prefs: { gender: u.gender, language: u.language, location: u.location }
  });
});

app.get("/api/online", (req, res) => {
  const online = [...usersByPhone.values()]
    .filter(u => socketsByPhone.has(u.phone))
    .map(u => ({
      phone: u.phone,
      name: u.name,
      avatar: u.avatar,
      prefs: { gender: u.gender, language: u.language, location: u.location },
      inCall: !!(status.get(u.phone)?.inCall),
      ringing: !!(status.get(u.phone)?.ringing)
    }));
  res.json({ online });
});

/* ------------------------------------------------
   Socket.IO: presence + calling
-------------------------------------------------*/
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

function presence() {
  const list = [...usersByPhone.values()]
    .filter(u => socketsByPhone.has(u.phone))
    .map(u => ({
      phone: u.phone,
      name: u.name,
      avatar: u.avatar,
      prefs: { gender: u.gender, language: u.language, location: u.location },
      inCall: !!(status.get(u.phone)?.inCall),
      ringing: !!(status.get(u.phone)?.ringing)
    }));
  io.emit("presence", list);
}

// pick any ONLINE, FREE opposite‑gender with same language
function pickOpponent(seekerPhone, mode) {
  const seeker = usersByPhone.get(seekerPhone);
  const cand = [...usersByPhone.values()]
    .filter(u =>
      u.phone !== seekerPhone &&
      socketsByPhone.has(u.phone) &&
      !status.get(u.phone)?.inCall &&
      !status.get(u.phone)?.ringing &&
      isOpp(seeker, u) &&
      sameLang(seeker, u)
    );
  if (cand.length === 0) return null;
  // simple random pick
  return cand[Math.floor(Math.random() * cand.length)];
}

io.on("connection", (socket) => {
  socket.on("auth", ({ phone }) => {
    const u = usersByPhone.get(phone);
    if (!u) { socket.emit("auth_error", { error: "Unknown user" }); return; }
    socketsByPhone.set(phone, socket.id);
    phoneBySocket.set(socket.id, phone);
    setAvail(phone, { inCall: false, ringing: false });
    socket.emit("auth_ok");
    presence();
  });

  socket.on("presence_get", () => presence());

  // seeker clicks Random Audio/Video
  socket.on("find_match", ({ mode, phone }) => {
    const seeker = usersByPhone.get(phone);
    if (!seeker) return;
    console.log(`🔎 MATCH_REQ phone=${phone} mode=${mode} gender=${seeker.gender} lang=${seeker.language}`);

    const target = pickOpponent(phone, mode);
    if (!target) {
      socket.emit("status", { text: "No suitable online partner right now." });
      return;
    }

    const roomId = uuidv4();
    const seekerSock = socketsByPhone.get(phone);
    const targetSock = socketsByPhone.get(target.phone);

    // mark ringing
    setAvail(phone, { ringing: true });
    setAvail(target.phone, { ringing: true });

    // tell both ends
    io.to(seekerSock).emit("outgoing_call", { roomId, mode, to: target });
    io.to(targetSock).emit("incoming_call", { roomId, mode, from: seeker });

    console.log(`📞 RING from=${phone} -> to=${target.phone} mode=${mode} room=${roomId}`);
  });

  socket.on("call_accept", ({ roomId }) => {
    const phone = phoneBySocket.get(socket.id);
    setAvail(phone, { inCall: true, ringing: false });
    // also set the peer to inCall (best-effort)
    // other party will set when they enter startCall
    socket.emit("call_accepted", { roomId, role: "answerer" });
    console.log(`✅ ACCEPT phone=${phone} room=${roomId}`);
  });

  socket.on("call_decline", ({ roomId }) => {
    const phone = phoneBySocket.get(socket.id);
    setAvail(phone, { ringing: false });
    socket.broadcast.emit("call_declined", { roomId });
    console.log(`❌ DECLINE phone=${phone} room=${roomId}`);
  });

  socket.on("cancel_invite", ({ roomId }) => {
    const phone = phoneBySocket.get(socket.id);
    setAvail(phone, { ringing: false });
    socket.broadcast.emit("call_cancelled", { roomId });
    console.log(`🚫 CANCEL phone=${phone} room=${roomId}`);
  });

  socket.on("join_room", ({ roomId }) => socket.join(roomId));
  socket.on("signal", ({ roomId, data }) => socket.to(roomId).emit("signal", { data }));

  socket.on("hangup", ({ roomId }) => {
    const phone = phoneBySocket.get(socket.id);
    setAvail(phone, { inCall: false, ringing: false });
    socket.to(roomId).emit("peer_hangup");
    console.log(`📴 HANGUP phone=${phone} room=${roomId}`);
  });

  socket.on("disconnect", () => {
    const phone = phoneBySocket.get(socket.id);
    if (phone) {
      socketsByPhone.delete(phone);
      phoneBySocket.delete(socket.id);
      setAvail(phone, { inCall: false, ringing: false });
      console.log(`🔌 DISCONNECT phone=${phone}`);
    }
    presence();
  });
});

/* ------------------------------------------------
   Start (Render will probe /healthz)
-------------------------------------------------*/
const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ FriendApp running on port ${PORT}`);
});
