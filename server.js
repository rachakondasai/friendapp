// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- In-memory store (swap for DB later) ----------
const users = new Map();   // phone -> {phone, name, pass, gender, coins, avatar, createdAt}
const prefs = new Map();   // phone -> {gender, language, location}
const sessions = new Map();// sessionId -> phone
const sockets = new Map(); // socket.id -> phone
const online = new Map();  // phone -> {socketId, available:true}
const history = [];        // [{aPhone,bPhone,mode,ms,startedAt}]

// ---------- Constants ----------
const AVATAR_URLS = {
  male:   "https://images.emojiterra.com/google/noto-emoji/unicode-16.0/color/svg/1f9d1.svg",
  female: "https://images.emojiterra.com/google/noto-emoji/unicode-16.0/color/svg/1f469.svg",
  default:"https://images.emojiterra.com/google/noto-emoji/unicode-16.0/color/svg/1f642.svg"
};
const COINS_PACKS = { 100: 1000, 200: 2000, 500: 5500, 1000: 12000 };
const COST_PER_CALL = 100;         // male must have at least this to start a call
const FEMALE_EARN_PER_5MIN = 500;  // coins per full 5 minutes call

// ---------- Helpers ----------
const sid = () => crypto.randomBytes(16).toString("hex");
const now = () => new Date().toISOString();
const setAvatarForUser = (phone, gender) => {
  const u = users.get(phone);
  if (!u) return;
  const g = (gender || u.gender || "").toLowerCase();
  u.avatar = AVATAR_URLS[g] || AVATAR_URLS.default;
};

// ---------- Routes (pages) ----------
app.get("/", (_req, res) => res.redirect("/welcome"));
app.get("/welcome",  (_req,res)=>res.sendFile(path.join(__dirname,"public/welcome.html")));
app.get("/signup",   (_req,res)=>res.sendFile(path.join(__dirname,"public/signup.html")));
app.get("/login",    (_req,res)=>res.sendFile(path.join(__dirname,"public/login.html")));
app.get("/prefs",    (_req,res)=>res.sendFile(path.join(__dirname,"public/prefs.html")));
app.get("/dashboard",(_req,res)=>res.sendFile(path.join(__dirname,"public/dashboard.html")));
app.get("/healthz",  (_req,res)=>res.type("text").send("ok"));

// ---------- Auth & Profile ----------
app.post("/api/signup", (req, res) => {
  const { phone, name, password } = req.body || {};
  if (!phone || !name || !password) return res.status(400).json({ error:"Missing fields" });
  if (users.has(phone)) return res.status(409).json({ error:"Phone already registered" });
  users.set(phone, { phone, name, pass: password, gender: "", avatar: AVATAR_URLS.default, coins: 0, createdAt: now() });
  console.log("🆕 signup:", phone, name);
  return res.json({ ok: true });
});

app.post("/api/login", (req, res) => {
  const { phone, password } = req.body || {};
  const u = users.get(phone);
  if (!u || u.pass !== password) return res.status(401).json({ error:"Invalid credentials" });
  const sessionId = sid();
  sessions.set(sessionId, phone);
  console.log("🔓 login:", phone);
  return res.json({ ok: true, sessionId, profile: { name: u.name, phone: u.phone } });
});

app.post("/api/reset", (req, res) => {
  const { phone, newPassword } = req.body || {};
  const u = users.get(phone);
  if (!u) return res.status(404).json({ error:"No such user" });
  u.pass = newPassword;
  console.log("🔁 password reset:", phone);
  return res.json({ ok: true });
});

app.post("/api/me", (req, res) => {
  const { phone } = req.body || {};
  const u = users.get(phone);
  if (!u) return res.status(404).json({ error:"Not found" });
  return res.json({ profile: u, prefs: prefs.get(phone) || {}, coins: u.coins });
});

app.post("/api/prefs", (req, res) => {
  const { phone, gender, language, location } = req.body || {};
  if (!users.has(phone)) return res.status(404).json({ error:"No such user" });
  if (!gender || !language) return res.status(400).json({ error:"Gender & language required" });
  prefs.set(phone, { gender, language, location });
  const u = users.get(phone);
  u.gender = gender;
  setAvatarForUser(phone, gender);
  console.log("⚙️  prefs set:", phone, JSON.stringify(prefs.get(phone)));
  return res.json({ ok: true, avatar: users.get(phone).avatar });
});

// ---------- Coins / Recharge (mock) ----------
app.post("/api/recharge-request", (req, res) => {
  const { phone, amount } = req.body || {};
  const u = users.get(phone);
  if (!u) return res.status(404).json({ error:"No such user" });
  const coins = COINS_PACKS[amount];
  if (!coins) return res.status(400).json({ error:"Invalid pack" });
  console.log(`💳 RECHARGE REQUEST phone=${phone} amount=₹${amount} -> coins=${coins} (pending admin)`);
  return res.json({ ok: true, note: "Recharge request logged. Admin will approve." });
});

// (demo) admin approval endpoint (you can comment out in real prod)
app.post("/api/admin/approve-recharge", (req, res) => {
  const { phone, amount } = req.body || {};
  const u = users.get(phone);
  if (!u) return res.status(404).json({ error:"No such user" });
  const coins = COINS_PACKS[amount];
  if (!coins) return res.status(400).json({ error:"Invalid pack" });
  u.coins += coins;
  console.log(`✅ ADMIN APPROVED: ${phone} +${coins} coins (₹${amount}) -> balance=${u.coins}`);
  return res.json({ ok: true, balance: u.coins });
});

// ---------- Presence & History ----------
app.post("/api/online", (_req, res) => {
  const list = Array.from(online.keys()).map(p => {
    const u = users.get(p);
    return {
      phone: p,
      name: u?.name || p,
      gender: u?.gender || "",
      avatar: u?.avatar || AVATAR_URLS.default,
      coins: u?.coins || 0,
      prefs: prefs.get(p) || {}
    };
  });
  res.json({ online: list });
});

app.post("/api/history", (req, res) => {
  const { phone } = req.body || {};
  const list = history.filter(h => h.aPhone === phone || h.bPhone === phone).slice(-50).reverse();
  res.json({ history: list });
});

// ---------- WebSocket: ringing/matching/signaling ----------
const roomMeta = new Map(); // roomId -> {aPhone,bPhone,mode,startAt}

io.on("connection", (socket) => {
  socket.on("auth", ({ phone }) => {
    if (!users.has(phone)) return;
    sockets.set(socket.id, phone);
    online.set(phone, { socketId: socket.id, available: true });
    console.log("🟢 online:", phone);
    socket.emit("presence", Array.from(online.keys()));
    socket.broadcast.emit("presence", Array.from(online.keys()));
  });

  socket.on("disconnect", () => {
    const phone = sockets.get(socket.id);
    if (phone) {
      online.delete(phone);
      sockets.delete(socket.id);
      console.log("🔴 offline:", phone);
      socket.broadcast.emit("presence", Array.from(online.keys()));
    }
  });

  // Random match request (opposite gender + same language)
  socket.on("find_match", async ({ phone, mode }) => {
    const me = users.get(phone);
    if (!me) return;
    const myPrefs = prefs.get(phone) || {};
    if (!myPrefs.gender || !myPrefs.language) {
      socket.emit("find_error", { error: "Set gender & language first" });
      return;
    }
    // male must have coins before starting
    if (myPrefs.gender === "male" && me.coins < COST_PER_CALL) {
      socket.emit("find_error", { error: "Low balance. Recharge required." });
      return;
    }
    // find opposite-gender online with same language
    const target = Array.from(online.keys()).find(p => {
      if (p === phone) return false;
      const pp = prefs.get(p) || {};
      return pp.gender && pp.gender !== myPrefs.gender && pp.language === myPrefs.language;
    });
    if (!target) {
      socket.emit("find_error", { error: "No opposite‑gender partner online in your language" });
      return;
    }

    const roomId = sid();
    const toSock = online.get(target)?.socketId;
    if (!toSock) { socket.emit("find_error", { error: "Peer went offline" }); return; }

    socket.join(roomId);
    io.to(toSock).emit("incoming_call", {
      roomId,
      mode,
      from: { phone, name: me.name, avatar: me.avatar }
    });
    io.to(socket.id).emit("outgoing_call", {
      roomId,
      mode,
      to: { phone: target, name: users.get(target)?.name, avatar: users.get(target)?.avatar }
    });

    roomMeta.set(roomId, { aPhone: phone, bPhone: target, mode, startAt: 0 });
    console.log(`📞 ring room=${roomId} ${phone} -> ${target} (${mode})`);
  });

  socket.on("call_accept", ({ roomId }) => {
    const meta = roomMeta.get(roomId); if (!meta) return;
    const { aPhone, bPhone, mode } = meta;
    const aSock = online.get(aPhone)?.socketId;
    const bSock = online.get(bPhone)?.socketId;

    // Re-check male coins on accept (final guard)
    const pa = prefs.get(aPhone)?.gender, pb = prefs.get(bPhone)?.gender;
    const male = pa === "male" ? aPhone : (pb === "male" ? bPhone : null);
    if (male && users.get(male).coins < COST_PER_CALL) {
      if (aSock) io.to(aSock).emit("call_error", { error: "Low balance" });
      if (bSock) io.to(bSock).emit("call_error", { error: "Peer has low balance" });
      return;
    }
    if (male) users.get(male).coins -= COST_PER_CALL;

    if (aSock) io.to(aSock).emit("call_accepted", { roomId, role: "offerer", mode });
    if (bSock) io.to(bSock).emit("call_accepted", { roomId, role: "answerer", mode });
    roomMeta.get(roomId).startAt = Date.now();

    console.log(`✅ accept room=${roomId} ${aPhone} <-> ${bPhone} (${mode})`);
  });

  socket.on("call_decline", ({ roomId }) => {
    const meta = roomMeta.get(roomId); if (!meta) return;
    const { aPhone, bPhone } = meta;
    const aSock = online.get(aPhone)?.socketId;
    const bSock = online.get(bPhone)?.socketId;
    if (aSock) io.to(aSock).emit("call_declined");
    if (bSock) io.to(bSock).emit("call_declined");
    roomMeta.delete(roomId);
    console.log(`❌ decline room=${roomId} ${aPhone} / ${bPhone}`);
  });

  socket.on("cancel_invite", ({ roomId }) => {
    const meta = roomMeta.get(roomId); if (!meta) return;
    const { aPhone, bPhone } = meta;
    const aSock = online.get(aPhone)?.socketId;
    const bSock = online.get(bPhone)?.socketId;
    if (aSock) io.to(aSock).emit("call_cancelled");
    if (bSock) io.to(bSock).emit("call_cancelled");
    roomMeta.delete(roomId);
    console.log(`↩️ cancel ring room=${roomId}`);
  });

  // WebRTC signaling passthrough
  socket.on("signal", ({ roomId, data }) => {
    const meta = roomMeta.get(roomId); if (!meta) return;
    const me = sockets.get(socket.id);
    const peer = me === meta.aPhone ? meta.bPhone : meta.aPhone;
    const peerSock = online.get(peer)?.socketId;
    if (peerSock) io.to(peerSock).emit("signal", { data });
  });

  // Hangup → record history, female earnings
  socket.on("hangup", ({ roomId }) => {
    const meta = roomMeta.get(roomId); if (!meta) return;
    const { aPhone, bPhone, mode, startAt } = meta;
    const dur = Math.max(0, Date.now() - (startAt || Date.now()));
    history.push({ aPhone, bPhone, mode, ms: dur, startedAt: new Date(startAt).toISOString() });

    const aSock = online.get(aPhone)?.socketId;
    const bSock = online.get(bPhone)?.socketId;
    if (aSock) io.to(aSock).emit("peer_hangup");
    if (bSock) io.to(bSock).emit("peer_hangup");

    const pa = prefs.get(aPhone)?.gender, pb = prefs.get(bPhone)?.gender;
    const female = pa === "female" ? aPhone : (pb === "female" ? bPhone : null);
    if (female) {
      const blocks = Math.floor(dur / (5 * 60 * 1000));
      const earn = blocks * FEMALE_EARN_PER_5MIN;
      if (earn > 0) {
        users.get(female).coins += earn;
        console.log(`💜 female-earn ${female} +${earn} coins for ${Math.round(dur/1000)}s`);
      }
    }

    roomMeta.delete(roomId);
    console.log(`☎️  hangup room=${roomId} dur=${Math.round(dur/1000)}s ${aPhone}<->${bPhone}`);
  });
});

// ---------- Start ----------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`✅ FriendApp running on port ${PORT}`);
});
