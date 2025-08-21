const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Health check
app.get("/healthz", (req, res) => res.send("ok"));

server.listen(process.env.PORT || 3000, "0.0.0.0", () =>
  console.log("FriendApp running on port " + (process.env.PORT || 3000))
);
