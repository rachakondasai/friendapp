import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { v4 as uuid } from "uuid";
import fs from "fs";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());
app.use(express.static("public", { extensions: ["html"] }));

// ---- persistence (very simple JSON) ----
const DB_FILE = "./data.json";
let DB = { users: [], prefs: [], sessions: {}, online: {}, history: [] };

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      DB = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    }
  } catch (e) { console.error("DB load error", e); }
}
function saveDB() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2)); } catch (e) {}
}
loadDB();

// small helpers
const norm = s => String(s || "").trim().toLowerCase();
const oppositeGender = (a, b) =>
  (norm(a) === "male" && norm(b) === "female") ||
  (norm(a) === "female" && norm(b) === "male");

// queues for random match
const queues = { audio: [], video: [] };

// -------- Health ----------
app.get("/healthz", (_, res) => res.send("ok"));

// -------- Root redirect ----------
app.get("/", (_, res) => {
  res.sendFile(process.cwd() + "/public/index.html");
});

// -------- Auth ----------
app.post("/api/signup", (req, res) => {
  const { name, phone, password } = req.body || {};
  if (!name || !phone || !password) return res.status(400).json({ error: "All fields required" });
  if (DB.users.find(u => u.phone === phone)) return res.status(409).json({ error: "Phone already used" });

  const user = { id: uuid(), name, phone, password, createdAt: Date.now() };
  DB.users.push(user);
  saveDB();
  return res.json({ ok: true });
});

app.post("/api/login", (req, res) => {
  const { phone, password } = req.body || {};
  const u = DB.users.find(x => x.phone === phone && x.password === password);
  if (!u) return res.status(401).json({ error: "Invalid credentials" });

  const token = uuid();
  DB.sessions[token] = u.id;
  saveDB();
  return res.json({ token, profile: { id: u.id, name: u.name, phone: u.phone } });
});

function authed(req, res, next) {
  const { token } = req.body || req.query || {};
  const uid = DB.sessions[token];
  if (!token || !uid) return res.status(401).json({ error: "Unauthorized" });
  req.uid = uid; next();
}

// -------- Profile / Prefs --------
app.post("/api/me", authed, (req, res) => {
  const u = DB.users.find(x => x.id === req.uid);
  const p = DB.prefs.find(x => x.userId === req.uid) || {};
  res.json({
    profile: { id: u.id, name: u.name, phone: u.phone, avatar: p.avatar || defaultAvatar(p.gender) },
    prefs: { gender: p.gender || "", language: p.language || "", location: p.location || "" }
  });
});

app.post("/api/prefs", authed, (req, res) => {
  const { gender, language, location } = req.body || {};
  let p = DB.prefs.find(x => x.userId === req.uid);
  if (!p) { p = { userId: req.uid }; DB.prefs.push(p); }
  p.gender = gender; p.language = language; p.location = location;
  // auto-avatar by gender
  p.avatar = defaultAvatar(gender);
  saveDB();
  res.json({ ok: true });
});

function defaultAvatar(gender) {
  const male = "https://cdn.jsdelivr.net/gh/edent/SuperTinyIcons/images/svg/man.svg";
  const female = "https://cdn.jsdelivr.net/gh/edent/SuperTinyIcons/images/svg/woman.svg";
  return norm(gender) === "female" ? female : male;
}

// ---- History (search) ----
app.post("/api/history", authed, (req, res) => {
  const q = norm(req.body?.q || "");
  const mine = DB.history.filter(h => h.a === req.uid || h.b === req.uid);
  const withNames = mine.map(h => {
    const peerId = h.a === req.uid ? h.b : h.a;
    const user = DB.users.find(u => u.id === peerId) || { name: "Unknown" };
    const pref = DB.prefs.find(p => p.userId === peerId) || {};
    return { ...h, name: user.name, email: user.phone, avatar: pref.avatar || defaultAvatar(pref.gender) };
  });
  const filtered = q ? withNames.filter(h => norm(h.name).includes(q)) : withNames;
  res.json({ history: filtered.slice(-50).reverse() });
});

// ---- STATIC pages fallback (nice URLs) ----
app.get("/signup", (_, res) => res.sendFile(process.cwd() + "/public/signup.html"));
app.get("/login",  (_, res) => res.sendFile(process.cwd() + "/public/login.html"));
app.get("/dashboard", (_, res) => res.sendFile(process.cwd() + "/public/dashboard.html"));
app.get("/settings",  (_, res) => res.sendFile(process.cwd() + "/public/settings.html"));

// ------------ Socket.IO -------------
const tokenBySocket = new Map();
const socketByUser = new Map();

io.on("connection", (socket) => {
  socket.on("auth", ({ token }) => {
    const uid = DB.sessions[token];
    if (!uid) return socket.emit("auth_error", { error: "Invalid token" });
    tokenBySocket.set(socket.id, token);
    socketByUser.set(uid, socket.id);
    DB.online[uid] = true;
    socket.emit("auth_ok");
    broadcastPresence();
  });

  socket.on("presence_get", () => {
    sendPresence(socket);
  });

  // call someone explicitly from online list
  socket.on("call_user", ({ targetId, mode }) => {
    const uid = DB.sessions[tokenBySocket.get(socket.id)];
    if (!uid) return;
    const pA = DB.prefs.find(x => x.userId === uid) || {};
    const pB = DB.prefs.find(x => x.userId === targetId) || {};
    if (!(oppositeGender(pA.gender, pB.gender) && norm(pA.language) === norm(pB.language))) {
      return socket.emit("match_error", { error: "Not compatible (gender/language)" });
    }

    const roomId = uuid();
    socket.join(roomId);
    const toSockId = socketByUser.get(targetId);
    if (toSockId) {
      io.to(toSockId).emit("incoming_call", {
        roomId, mode, from: userCard(uid)
      });
      socket.emit("outgoing_call", {
        roomId, mode, to: userCard(targetId)
      });
      setTimeout(() => {
        const room = io.sockets.adapter.rooms.get(roomId);
        if (room && room.size < 2) {
          io.to(roomId).emit("call_timeout");
          io.socketsLeave(roomId);
        }
      }, 20000);
    } else {
      socket.emit("match_error", { error: "User went offline" });
    }
  });

  // random match
  socket.on("find_match", ({ mode }) => {
    const token = tokenBySocket.get(socket.id);
    const uid = DB.sessions[token];
    const mePref = DB.prefs.find(x => x.userId === uid);
    if (!mePref?.gender || !mePref?.language) {
      return socket.emit("match_error", { error: "Set preferences first" });
    }
    const seeker = { uid, socketId: socket.id, ...mePref };
    const partnerIndex = queues[mode].findIndex(c =>
      c.uid !== uid &&
      oppositeGender(c.gender, mePref.gender) &&
      norm(c.language) === norm(mePref.language)
    );
    if (partnerIndex >= 0) {
      const partner = queues[mode].splice(partnerIndex, 1)[0];
      const roomId = uuid();
      io.sockets.sockets.get(seeker.socketId)?.join(roomId);
      io.sockets.sockets.get(partner.socketId)?.join(roomId);

      // who offers?
      const offererUid = Math.random() < 0.5 ? seeker.uid : partner.uid;
      const answererUid = offererUid === seeker.uid ? partner.uid : seeker.uid;

      io.to(socketByUser.get(offererUid)).emit("outgoing_call", {
        roomId, mode, to: userCard(answererUid)
      });
      io.to(socketByUser.get(answererUid)).emit("incoming_call", {
        roomId, mode, from: userCard(offererUid)
      });

      setTimeout(() => {
        const room = io.sockets.adapter.rooms.get(roomId);
        if (room && room.size < 2) {
          io.to(roomId).emit("call_timeout");
          io.socketsLeave(roomId);
        }
      }, 20000);
    } else {
      queues[mode].push(seeker);
      socket.emit("queued", { mode });
    }
  });

  socket.on("cancel_find", ({ mode }) => {
    const token = tokenBySocket.get(socket.id);
    const uid = DB.sessions[token];
    const idx = queues[mode].findIndex(q => q.uid === uid);
    if (idx >= 0) queues[mode].splice(idx, 1);
  });

  socket.on("call_accept", ({ roomId }) => {
    socket.join(roomId);
    const role = "answerer";
    const mode = "video"; // role only; actual mode known to both by context
    io.to(roomId).emit("call_accepted", { roomId, role, mode });
  });

  socket.on("call_decline", ({ roomId }) => {
    io.to(roomId).emit("call_declined");
    io.socketsLeave(roomId);
  });

  socket.on("cancel_invite", ({ roomId }) => {
    io.to(roomId).emit("call_cancelled");
    io.socketsLeave(roomId);
  });

  socket.on("signal", ({ roomId, data }) => {
    socket.to(roomId).emit("signal", { data });
  });

  socket.on("hangup", ({ roomId }) => {
    // record history if room had two people
    const sockets = [...(io.sockets.adapter.rooms.get(roomId) ?? [])];
    if (sockets.length >= 2) {
      const ids = sockets.map(sid => DB.sessions[tokenBySocket.get(sid)]).filter(Boolean);
      if (ids.length === 2) {
        DB.history.push({ a: ids[0], b: ids[1], ts: Date.now(), mode: "call" });
        DB.history = DB.history.slice(-500);
        saveDB();
      }
    }
    socket.to(roomId).emit("peer_hangup");
    io.socketsLeave(roomId);
  });

  socket.on("disconnect", () => {
    const token = tokenBySocket.get(socket.id);
    const uid = DB.sessions[token];
    if (uid) {
      DB.online[uid] = false;
      tokenBySocket.delete(socket.id);
      socketByUser.delete(uid);
      // remove from queues
      for (const m of Object.keys(queues)) {
        const i = queues[m].findIndex(q => q.uid === uid);
        if (i >= 0) queues[m].splice(i, 1);
      }
      broadcastPresence();
    }
  });
});

function userCard(uid) {
  const u = DB.users.find(x => x.id === uid) || {};
  const p = DB.prefs.find(x => x.userId === uid) || {};
  return { id: uid, name: u.name, phone: u.phone, avatar: p.avatar || defaultAvatar(p.gender), prefs: p };
}

function presenceList() {
  return DB.users
    .filter(u => DB.online[u.id])
    .map(u => userCard(u.id));
}
function sendPresence(socket) { socket.emit("presence", presenceList()); }
function broadcastPresence() { io.emit("presence", presenceList()); }

// -------- Start server ----------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("✅ FriendApp running on port", PORT);
});
