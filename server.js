import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

/* ----------------------------- App & Static ----------------------------- */
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public", { extensions: ["html"] }));

app.get("/", (req, res) => res.redirect("/login"));
app.get("/healthz", (req, res) => res.status(200).send("ok"));

/* ------------------------------ Data Store ------------------------------ */
/** Very simple in‑memory demo store (persisted only while process runs) */
const usersByPhone = new Map(); // phone -> {phone,name,password,gender,language,location,avatar,coins}
const socketsByPhone = new Map(); // phone -> socketId
const phoneBySocket = new Map();  // socketId -> phone
const status = new Map();         // phone -> { inCall:boolean, ringing:boolean }

/** roomId -> { a:phone, b:phone, mode:'audio'|'video', started:boolean, startTs:number|null, joined:Set<phone> } */
const roomMeta = new Map();

const norm = s => String(s || "").trim().toLowerCase();
const isOppGender = (a, b) =>
  (norm(a.gender) === "male" && norm(b.gender) === "female") ||
  (norm(a.gender) === "female" && norm(b.gender) === "male");

const sameLanguage = (a, b) => {
  if (!a.language || !b.language) return true;
  return norm(a.language) === norm(b.language);
};
const setAvail = (phone, patch) => {
  const curr = status.get(phone) || { inCall: false, ringing: false };
  status.set(phone, { ...curr, ...patch });
};

/* ------------------------------- REST API ------------------------------- */

// Sign up
app.post("/api/signup", (req, res) => {
  const { phone, name, password } = req.body || {};
  if (!phone || !name || !password) return res.status(400).json({ error: "All fields required" });
  if (usersByPhone.has(phone)) return res.status(409).json({ error: "Phone already exists" });

  usersByPhone.set(phone, {
    phone, name, password,
    gender: "", language: "", location: "",
    avatar: "/avatars/neutral.png",
    coins: 0
  });

  console.log(`👤 SIGNUP phone=${phone} name=${name}`);
  return res.json({ ok: true });
});

// Login
app.post("/api/login", (req, res) => {
  const { phone, password } = req.body || {};
  const u = usersByPhone.get(phone);
  if (!u || u.password !== password) return res.status(401).json({ error: "Invalid credentials" });
  console.log(`✅ LOGIN phone=${phone} name=${u.name}`);
  return res.json({ ok: true, profile: { phone: u.phone, name: u.name } });
});

// Reset password (simple demo: phone + newPassword)
app.post("/api/reset", (req, res) => {
  const { phone, newPassword } = req.body || {};
  const u = usersByPhone.get(phone);
  if (!u) return res.status(404).json({ error: "User not found" });
  if (!newPassword) return res.status(400).json({ error: "New password required" });
  u.password = newPassword;
  console.log(`🔑 RESET password phone=${phone}`);
  return res.json({ ok: true });
});

// Save preferences
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

// Current user
app.post("/api/me", (req, res) => {
  const { phone } = req.body || {};
  const u = usersByPhone.get(phone);
  if (!u) return res.status(404).json({ error: "Not found" });
  const emoji = norm(u.gender) === "male" ? "♂️" : norm(u.gender) === "female" ? "♀️" : "🙂";
  return res.json({
    profile: { name: `${u.name} ${emoji}`, phone: u.phone, avatar: u.avatar },
    prefs: { gender: u.gender, language: u.language, location: u.location },
    wallet: { coins: u.coins }
  });
});

// Online users
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

// Coins: recharge (male only)
app.post("/api/recharge", (req, res) => {
  const { phone, pack } = req.body || {};
  const u = usersByPhone.get(phone);
  if (!u) return res.status(404).json({ error: "User not found" });
  if (norm(u.gender) !== "male") return res.status(403).json({ error: "Only male users can recharge" });

  const packs = {
    "100": 1000,
    "200": 2200,
    "500": 6000
  };
  const coins = packs[String(pack)];
  if (!coins) return res.status(400).json({ error: "Invalid pack" });

  u.coins += coins;
  console.log(`💳 RECHARGE phone=${phone} pack=₹${pack} +${coins} coins -> balance=${u.coins}`);
  return res.json({ ok: true, coinsAdded: coins, balance: u.coins });
});

// Coins: redeem (female only)
app.post("/api/redeem", (req, res) => {
  const { phone, amount, upi } = req.body || {};
  const u = usersByPhone.get(phone);
  if (!u) return res.status(404).json({ error: "User not found" });
  if (norm(u.gender) !== "female") return res.status(403).json({ error: "Only female users can redeem" });

  const amt = Math.max(0, Math.floor(Number(amount || 0)));
  if (!amt) return res.status(400).json({ error: "Amount required" });
  if (!upi) return res.status(400).json({ error: "UPI id required" });
  if (amt > u.coins) return res.status(400).json({ error: "Insufficient coins" });

  u.coins -= amt;
  console.log(`🏧 REDEEM phone=${phone} -${amt} coins to ${upi} -> balance=${u.coins}`);
  return res.json({ ok: true, balance: u.coins });
});

/* ---------------------------- Socket + Calling --------------------------- */
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

function broadcastPresence() {
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

function pickOpponent(seekerPhone) {
  const seeker = usersByPhone.get(seekerPhone);
  if (!seeker) return null;
  const candidates = [...usersByPhone.values()].filter(u =>
    u.phone !== seekerPhone &&
    socketsByPhone.has(u.phone) &&
    !status.get(u.phone)?.inCall &&
    !status.get(u.phone)?.ringing &&
    isOppGender(seeker, u) &&
    sameLanguage(seeker, u)
  );
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

io.on("connection", (socket) => {
  socket.on("auth", ({ phone }) => {
    const u = usersByPhone.get(phone);
    if (!u) { socket.emit("auth_error", { error: "Unknown user" }); return; }
    socketsByPhone.set(phone, socket.id);
    phoneBySocket.set(socket.id, phone);
    setAvail(phone, { inCall: false, ringing: false });
    socket.emit("auth_ok");
    broadcastPresence();
  });

  socket.on("presence_get", () => broadcastPresence());

  // Random match -> ring an opposite-gender user who is online and free
  socket.on("find_match", ({ mode, phone }) => {
    const seeker = usersByPhone.get(phone);
    if (!seeker) return;

    console.log(`🔎 MATCH_REQ phone=${phone} mode=${mode} gender=${seeker.gender} lang=${seeker.language}`);

    const target = pickOpponent(phone);
    if (!target) {
      socket.emit("status", { text: "No suitable online partner right now." });
      return;
    }

    const roomId = uuidv4();
    const sSock = socketsByPhone.get(seeker.phone);
    const tSock = socketsByPhone.get(target.phone);

    roomMeta.set(roomId, {
      a: seeker.phone, b: target.phone, mode,
      started: false, startTs: null, joined: new Set()
    });

    setAvail(seeker.phone, { ringing: true });
    setAvail(target.phone, { ringing: true });

    io.to(sSock).emit("outgoing_call", { roomId, mode, to: target });
    io.to(tSock).emit("incoming_call", { roomId, mode, from: seeker });

    console.log(`📞 RING from=${seeker.phone} -> to=${target.phone} mode=${mode} room=${roomId}`);
    broadcastPresence();
  });

  socket.on("call_accept", ({ roomId }) => {
    const phone = phoneBySocket.get(socket.id);
    setAvail(phone, { inCall: true, ringing: false });
    socket.emit("call_accepted", { roomId, role: "answerer" });
    console.log(`✅ ACCEPT phone=${phone} room=${roomId}`);
    broadcastPresence();
  });

  socket.on("call_decline", ({ roomId }) => {
    const phone = phoneBySocket.get(socket.id);
    setAvail(phone, { ringing: false });
    socket.broadcast.emit("call_declined", { roomId });
    console.log(`❌ DECLINE phone=${phone} room=${roomId}`);
    broadcastPresence();
  });

  socket.on("cancel_invite", ({ roomId }) => {
    const phone = phoneBySocket.get(socket.id);
    setAvail(phone, { ringing: false });
    socket.broadcast.emit("call_cancelled", { roomId });
    console.log(`🚫 CANCEL phone=${phone} room=${roomId}`);
    broadcastPresence();
  });

  socket.on("join_room", ({ roomId }) => {
    const meta = roomMeta.get(roomId);
    if (!meta) return;
    const phone = phoneBySocket.get(socket.id);
    meta.joined.add(phone);
    socket.join(roomId);
    if (!meta.started && meta.joined.has(meta.a) && meta.joined.has(meta.b)) {
      meta.started = true; meta.startTs = Date.now();
      console.log(`🎬 CALL_START room=${roomId} a=${meta.a} b=${meta.b} mode=${meta.mode}`);
      setAvail(meta.a, { inCall: true, ringing: false });
      setAvail(meta.b, { inCall: true, ringing: false });
      broadcastPresence();
    }
  });

  socket.on("signal", ({ roomId, data }) => socket.to(roomId).emit("signal", { data }));

  socket.on("hangup", ({ roomId }) => {
    const meta = roomMeta.get(roomId);
    const who = phoneBySocket.get(socket.id);
    if (meta) {
      const durMs = meta.startTs ? Date.now() - meta.startTs : 0;
      const mins = Math.floor(durMs / 60000);
      const coinsPerMin = 100; // 5 min => 500 coins
      // Award females only
      [meta.a, meta.b].forEach(ph => {
        const u = usersByPhone.get(ph);
        if (u && norm(u.gender) === "female" && mins > 0) {
          const add = mins * coinsPerMin;
          u.coins += add;
          const sock = socketsByPhone.get(ph);
          io.to(sock).emit("call_summary", { durationMs: durMs, coinsAdded: add, balance: u.coins });
          console.log(`💠 COINS phone=${ph} +${add} (mins=${mins}) -> balance=${u.coins}`);
        }
      });
      console.log(`🏁 CALL_END room=${roomId} duration=${Math.round(durMs/1000)}s endedBy=${who}`);
      roomMeta.delete(roomId);
      setAvail(meta.a, { inCall: false, ringing: false });
      setAvail(meta.b, { inCall: false, ringing: false });
      io.to(roomId).emit("peer_hangup");
      broadcastPresence();
    }
  });

  socket.on("disconnect", () => {
    const phone = phoneBySocket.get(socket.id);
    if (phone) {
      socketsByPhone.delete(phone);
      phoneBySocket.delete(socket.id);
      setAvail(phone, { inCall: false, ringing: false });
      console.log(`🔌 DISCONNECT phone=${phone}`);
      broadcastPresence();
    }
  });
});

/* ------------------------------- Start App ------------------------------ */
const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ FriendApp running on port ${PORT}`);
});
