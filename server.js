// ============================================================
//  server.js — Secure message broker for render.com
//  Node.js >= 18, no database, in-memory storage
// ============================================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();

// ---------- middleware ----------
app.use(cors());
app.use(express.json({ limit: '64kb' }));

// ---------- constants ----------
const MESSAGE_TTL   = 30_000;   // сообщение живёт 30 с
const USER_TTL      = 120_000;  // пользователь «жив» 2 мин
const MAX_PER_CH    = 200;      // макс. сообщений в канале
const CLEANUP_EVERY = 10_000;   // интервал очистки

// ---------- storage ----------
const rooms = Object.create(null);

// ---------- helpers ----------
function getRoom(id) {
  if (!rooms[id]) rooms[id] = { users: Object.create(null),
                                 channels: Object.create(null) };
  return rooms[id];
}

function touchUser(room, name) {
  if (!room.users[name]) room.users[name] = {};
  room.users[name].lastSeen = Date.now();
}

function cleanup() {
  const now = Date.now();
  for (const rid in rooms) {
    const r = rooms[rid];

    for (const ch in r.channels) {
      r.channels[ch] = r.channels[ch].filter(m => now - m.ts < MESSAGE_TTL);
      if (!r.channels[ch].length) delete r.channels[ch];
    }

    for (const u in r.users) {
      if (now - r.users[u].lastSeen > USER_TTL) delete r.users[u];
    }

    if (!Object.keys(r.users).length) delete rooms[rid];
  }
}

setInterval(cleanup, CLEANUP_EVERY);

// ---------- routes ----------

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    rooms: Object.keys(rooms).length,
    uptime: process.uptime() | 0
  });
});

app.post('/join', (req, res) => {
  const { room, user } = req.body;
  if (!room || !user)
    return res.status(400).json({ error: 'room and user required' });

  const r = getRoom(room);
  if (r.users[user] &&
      Date.now() - r.users[user].lastSeen < USER_TTL) {
  }

  touchUser(r, user);
  res.json({ ok: true, users: Object.keys(r.users) });
});

app.post('/leave', (req, res) => {
  const { room, user } = req.body;
  if (rooms[room] && rooms[room].users[user])
    delete rooms[room].users[user];
  res.json({ ok: true });
});

app.post('/send', (req, res) => {
  const { room, user, channel, data } = req.body;
  if (!room || !user || !channel || data === undefined)
    return res.status(400).json({ error: 'missing fields' });

  if (!rooms[room])
    return res.status(404).json({ error: 'room not found' });

  const r = rooms[room];
  touchUser(r, user);

  if (!r.channels[channel]) r.channels[channel] = [];

  const msg = {
    id: crypto.randomUUID(),
    from: user,
    data,
    ts: Date.now()
  };

  r.channels[channel].push(msg);
  if (r.channels[channel].length > MAX_PER_CH)
    r.channels[channel] = r.channels[channel].slice(-MAX_PER_CH);

  res.json({ ok: true, id: msg.id });
});

app.post('/poll', (req, res) => {
  const { room, user, cursors = {} } = req.body;
  if (!room || !user)
    return res.status(400).json({ error: 'missing fields' });

  if (!rooms[room])
    return res.json({ ok: true, messages: {}, users: [] });

  const r = rooms[room];
  touchUser(r, user);
  const result = {};

  for (const ch in r.channels) {
    const msgs = r.channels[ch];
    let startIdx = 0;

    if (cursors[ch]) {
      const idx = msgs.findIndex(m => m.id === cursors[ch]);
      if (idx !== -1) startIdx = idx + 1;
      else startIdx = msgs.length;
    }

    const fresh = msgs.slice(startIdx).filter(m => m.from !== user);
    if (fresh.length) result[ch] = fresh;
  }

  res.json({
    ok: true,
    messages: result,
    users: Object.keys(r.users)
  });
});

// ---------- start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Broker on :${PORT}`));
