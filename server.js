// ============================================================
//  server.js — Secure message broker with Gist authentication
//  Node.js >= 18, user database in GitHub Gist
//  Optimized for Render.com deployment
// ============================================================

'use strict';

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');

// ============================================================
// Environment validation
// ============================================================

const REQUIRED_ENV = [
  'GIST_DECRYPT_KEY',
  'PASSWORD_KEY_1',
  'PASSWORD_KEY_2',
  'GIST_ID',
  'GITHUB_TOKEN',
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[FATAL] Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const GIST_DECRYPT_KEY = process.env.GIST_DECRYPT_KEY;
const PASSWORD_KEY_1   = process.env.PASSWORD_KEY_1;
const PASSWORD_KEY_2   = process.env.PASSWORD_KEY_2;
const GIST_ID          = process.env.GIST_ID;
const GITHUB_TOKEN     = process.env.GITHUB_TOKEN;

// ============================================================
// Configuration
// ============================================================

const MESSAGE_TTL            = 30_000;
const USER_TTL               = 120_000;
const MAX_PER_CH             = 200;
const CLEANUP_EVERY          = 10_000;
const DB_CACHE_TTL           = 60_000;
const SESSION_TTL            = 24 * 60 * 60 * 1_000;
const SESSION_ABSOLUTE_TTL   =  7 * 24 * 60 * 60 * 1_000;
const MAX_SESSIONS_TOTAL     = 50_000;
const MAX_SESSIONS_PER_USER  = 10;
const MAX_USERNAME_LEN       = 64;
const MAX_PASSWORD_LEN       = 128;
const MAX_ROOM_LEN           = 64;
const MAX_CHANNEL_LEN        = 64;
const MAX_DATA_LEN           = 65_536;
const RATE_LIMIT_MAP_MAX     = 10_000;
const RATE_LIMIT_WINDOW      = 60_000;
const RATE_LIMIT_MAX_LOGIN   = 10;
const RATE_LIMIT_MAX_API     = 120;

const SAFE_NAME_RE = /^[\w\-]{1,64}$/;
const UUID_RE      = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_RE       = /^[0-9a-f]+$/i;

// ============================================================
// Rate limiting
// ============================================================

const loginAttempts = new Map();
const apiAttempts   = new Map();

function isRateLimited(map, ip, max) {
  const now = Date.now();
  let rec = map.get(ip);

  if (!rec || now > rec.resetAt) {
    if (!rec && map.size >= RATE_LIMIT_MAP_MAX) return true;
    rec = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    map.set(ip, rec);
  }

  rec.count++;
  return rec.count > max;
}

// ============================================================
// Encryption utilities
// ============================================================

function deriveKey(keyStr) {
  return crypto.createHash('sha256').update(keyStr).digest();
}

function encrypt(plaintext, keyStr) {
  const key       = deriveKey(keyStr);
  const iv        = crypto.randomBytes(12);
  const cipher    = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}

function decrypt(ciphertext, keyStr) {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('Invalid ciphertext format');

  const [ivHex, authTagHex, encryptedHex] = parts;

  if (ivHex.length !== 24)      throw new Error('Invalid IV length');
  if (authTagHex.length !== 32) throw new Error('Invalid authTag length');

  if (!HEX_RE.test(ivHex))      throw new Error('Invalid hex in IV');
  if (!HEX_RE.test(authTagHex)) throw new Error('Invalid hex in authTag');
  if (encryptedHex.length > 0 && !HEX_RE.test(encryptedHex))
                                 throw new Error('Invalid hex in ciphertext');

  const key     = deriveKey(keyStr);
  const iv      = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const data    = Buffer.from(encryptedHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(data),
    decipher.final(),
  ]).toString('utf8');
}

// ============================================================
// User authentication
// ============================================================

function userToPassword(username) {
  const combinedKey = PASSWORD_KEY_1 + ':' + PASSWORD_KEY_2;
  return crypto.createHmac('sha256', combinedKey)
    .update(username)
    .digest('hex');
}

let usersDBCache = null;
let lastDBFetch  = 0;

async function fetchUsersDB() {
  const now = Date.now();
  if (usersDBCache && now - lastDBFetch < DB_CACHE_TTL) {
    return usersDBCache;
  }

  try {
    const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      console.error('[Gist] fetch failed:', response.status);
      return usersDBCache ?? [];
    }

    const gist = await response.json();
    const file  = Object.values(gist.files)[0];

    if (!file?.content) {
      console.error('[Gist] empty file');
      return usersDBCache ?? [];
    }

    const users = JSON.parse(decrypt(file.content, GIST_DECRYPT_KEY));
    if (!Array.isArray(users)) throw new Error('DB is not an array');

    usersDBCache = users;
    lastDBFetch  = now;
    console.log(`[Gist] Successfully fetched ${users.length} users`);
    return users;

  } catch (err) {
    console.error('[Gist] error:', err.message);
    return usersDBCache ?? [];
  }
}

async function verifyCredentials(username, password) {
  const users      = await fetchUsersDB();
  const userExists = users.includes(username);

  const lookupName = userExists ? username : '\x00__invalid__\x00';
  const expected   = userToPassword(lookupName);

  const FIXED_LEN = 64;

  const eBuf = Buffer.alloc(FIXED_LEN);
  const pBuf = Buffer.alloc(FIXED_LEN);

  Buffer.from(expected).copy(eBuf);
  Buffer.from(password).copy(pBuf, 0, 0, FIXED_LEN);

  const match = crypto.timingSafeEqual(eBuf, pBuf);

  return match && userExists;
}

// ============================================================
// In-memory storage
// ============================================================

const rooms                 = Object.create(null);
const authenticatedSessions = new Map();
const userSessionIndex      = new Map();

function isValidName(str, maxLen = 64) {
  return typeof str === 'string' &&
         str.length >= 1 &&
         str.length <= maxLen &&
         SAFE_NAME_RE.test(str);
}

function getRoom(id) {
  if (!rooms[id]) {
    rooms[id] = {
      users:    Object.create(null),
      channels: Object.create(null),
    };
  }
  return rooms[id];
}

function touchUser(room, name) {
  if (!room.users[name]) room.users[name] = {};
  room.users[name].lastSeen = Date.now();
}

function deleteSession(sessionId, username) {
  authenticatedSessions.delete(sessionId);
  const userSessions = userSessionIndex.get(username);
  if (userSessions) {
    userSessions.delete(sessionId);
    if (userSessions.size === 0) userSessionIndex.delete(username);
  }
}

function verifySession(sessionId) {
  if (typeof sessionId !== 'string') return null;
  const session = authenticatedSessions.get(sessionId);
  if (!session) return null;

  const now = Date.now();

  if (now > session.absoluteExpires || now > session.expires) {
    deleteSession(sessionId, session.user);
    return null;
  }

  session.expires = Math.min(now + SESSION_TTL, session.absoluteExpires);
  return session;
}

// ============================================================
// Cleanup task
// ============================================================

function cleanup() {
  const now = Date.now();

  for (const [id, s] of authenticatedSessions) {
    if (now > s.expires || now > s.absoluteExpires) {
      deleteSession(id, s.user);
    }
  }

  for (const [ip, rec] of loginAttempts) {
    if (now > rec.resetAt) loginAttempts.delete(ip);
  }

  for (const [ip, rec] of apiAttempts) {
    if (now > rec.resetAt) apiAttempts.delete(ip);
  }

  for (const rid of Object.keys(rooms)) {
    const r = rooms[rid];

    for (const ch of Object.keys(r.channels)) {
      r.channels[ch] = r.channels[ch].filter(m => now - m.ts < MESSAGE_TTL);
      if (!r.channels[ch].length) delete r.channels[ch];
    }

    for (const u of Object.keys(r.users)) {
      if (now - r.users[u].lastSeen > USER_TTL) delete r.users[u];
    }

    if (!Object.keys(r.users).length) delete rooms[rid];
  }
}

setInterval(cleanup, CLEANUP_EVERY).unref();

// ============================================================
// Express app setup
// ============================================================

const app = express();

// Trust Render's proxy
app.set('trust proxy', 1);

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// CORS
app.use(cors({
  origin:         process.env.CORS_ORIGIN || '*',
  methods:        ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials:    false,
}));

// Body parser
app.use(express.json({ limit: '128kb' }));

// ============================================================
// Health check endpoints (for Render)
// ============================================================

app.get('/', (_req, res) => {
  res.json({ 
    status: 'ok',
    service: 'secure-msg-broker',
    version: '1.0.0'
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    sessions: authenticatedSessions.size,
    rooms: Object.keys(rooms).length
  });
});

// ============================================================
// API endpoints
// ============================================================

app.post('/login', async (req, res) => {
  const ip = req.ip ?? 'unknown';

  if (isRateLimited(loginAttempts, ip, RATE_LIMIT_MAX_LOGIN)) {
    return res.status(429).json({ error: 'Too many login attempts' });
  }

  const { username, password } = req.body ?? {};

  if (
    typeof username !== 'string' || !username ||
    typeof password !== 'string' || !password
  ) {
    return res.status(400).json({ error: 'username and password required' });
  }

  if (username.length > MAX_USERNAME_LEN || password.length > MAX_PASSWORD_LEN) {
    return res.status(400).json({ error: 'username or password too long' });
  }

  const isValid = await verifyCredentials(username, password);
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (authenticatedSessions.size >= MAX_SESSIONS_TOTAL) {
    return res.status(503).json({ error: 'Server session limit reached' });
  }

  const existingSessions = userSessionIndex.get(username);
  if (existingSessions && existingSessions.size >= MAX_SESSIONS_PER_USER) {
    const oldestId = existingSessions.values().next().value;
    deleteSession(oldestId, username);
  }

  const sessionId = crypto.randomUUID();
  const now       = Date.now();

  authenticatedSessions.set(sessionId, {
    user:            username,
    expires:         now + SESSION_TTL,
    absoluteExpires: now + SESSION_ABSOLUTE_TTL,
  });

  if (!userSessionIndex.has(username)) userSessionIndex.set(username, new Set());
  userSessionIndex.get(username).add(sessionId);

  res.json({ ok: true, sessionId, username });
});

app.post('/logout', (req, res) => {
  const { sessionId } = req.body ?? {};
  const session = verifySession(sessionId);
  if (session) {
    deleteSession(sessionId, session.user);
  }
  res.json({ ok: true });
});

app.post('/join', (req, res) => {
  if (isRateLimited(apiAttempts, req.ip ?? 'unknown', RATE_LIMIT_MAX_API)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const { room, sessionId } = req.body ?? {};

  if (!room || !sessionId) {
    return res.status(400).json({ error: 'room and sessionId required' });
  }

  if (!isValidName(room, MAX_ROOM_LEN)) {
    return res.status(400).json({ error: 'invalid room name' });
  }

  const session = verifySession(sessionId);
  if (!session) return res.status(401).json({ error: 'Invalid or expired session' });

  const r = getRoom(room);
  touchUser(r, session.user);

  res.json({ ok: true, users: Object.keys(r.users), username: session.user });
});

app.post('/leave', (req, res) => {
  if (isRateLimited(apiAttempts, req.ip ?? 'unknown', RATE_LIMIT_MAX_API)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const { room, sessionId } = req.body ?? {};

  if (!isValidName(room, MAX_ROOM_LEN)) {
    return res.status(400).json({ error: 'invalid room name' });
  }

  const session = verifySession(sessionId);
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  if (rooms[room]?.users[session.user]) {
    delete rooms[room].users[session.user];
  }

  res.json({ ok: true });
});

app.post('/send', (req, res) => {
  if (isRateLimited(apiAttempts, req.ip ?? 'unknown', RATE_LIMIT_MAX_API)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const { room, sessionId, channel, data } = req.body ?? {};

  if (!room || !sessionId || !channel || data === undefined) {
    return res.status(400).json({ error: 'missing fields' });
  }

  if (!isValidName(room, MAX_ROOM_LEN) || !isValidName(channel, MAX_CHANNEL_LEN)) {
    return res.status(400).json({ error: 'invalid room or channel name' });
  }

  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  if (dataStr.length > MAX_DATA_LEN) {
    return res.status(413).json({ error: 'data too large' });
  }

  const session = verifySession(sessionId);
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  if (!rooms[room]?.users[session.user]) {
    return res.status(403).json({ error: 'Join the room first' });
  }

  const r = getRoom(room);
  touchUser(r, session.user);

  if (!r.channels[channel]) r.channels[channel] = [];

  if (r.channels[channel].length >= MAX_PER_CH) {
    r.channels[channel].splice(0, r.channels[channel].length - MAX_PER_CH + 1);
  }

  const msg = {
    id:   crypto.randomUUID(),
    from: session.user,
    data: dataStr,
    ts:   Date.now(),
  };

  r.channels[channel].push(msg);

  res.json({ ok: true, id: msg.id });
});

app.post('/poll', (req, res) => {
  if (isRateLimited(apiAttempts, req.ip ?? 'unknown', RATE_LIMIT_MAX_API)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const { room, sessionId, cursors } = req.body ?? {};

  if (!room || !sessionId) {
    return res.status(400).json({ error: 'missing fields' });
  }

  if (!isValidName(room, MAX_ROOM_LEN)) {
    return res.status(400).json({ error: 'invalid room name' });
  }

  const session = verifySession(sessionId);
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  if (!rooms[room]?.users[session.user]) {
    return res.status(403).json({ error: 'Join the room first' });
  }

  const safeCursors =
    cursors !== null && typeof cursors === 'object' && !Array.isArray(cursors)
      ? cursors
      : {};

  const r      = rooms[room];
  const user   = session.user;
  const result = Object.create(null);

  touchUser(r, user);

  for (const ch of Object.keys(r.channels)) {
    const msgs      = r.channels[ch];
    const rawCursor = safeCursors[ch];

    const cursorId = typeof rawCursor === 'string' && UUID_RE.test(rawCursor)
      ? rawCursor
      : null;

    let startIdx = 0;
    if (cursorId) {
      const idx = msgs.findIndex(m => m.id === cursorId);
      startIdx  = idx !== -1 ? idx + 1 : msgs.length;
    }

    const fresh = msgs.slice(startIdx).filter(m => m.from !== user);
    if (fresh.length) result[ch] = fresh;
  }

  res.json({ ok: true, messages: result, users: Object.keys(r.users) });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================
// Graceful shutdown
// ============================================================

function shutdown(signal) {
  console.log(`[broker] ${signal} received, shutting down gracefully...`);
  
  // Stop accepting new connections
  server.close(() => {
    console.log('[broker] Server closed');
    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error('[broker] Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ============================================================
// Server startup
// ============================================================

const PORT = Number(process.env.PORT) || 10000;
const HOST = '0.0.0.0'; // Critical for Render

// Pre-fetch user database
fetchUsersDB()
  .then(() => console.log('[broker] Initial user database fetch completed'))
  .catch(err => console.error('[broker] Initial DB fetch failed (will retry):', err.message));

const server = app.listen(PORT, HOST, () => {
  console.log('='.repeat(60));
  console.log('[broker] ✓ Server started successfully');
  console.log(`[broker] ✓ Listening on ${HOST}:${PORT}`);
  console.log(`[broker] ✓ Environment: ${process.env.NODE_ENV || 'production'}`);
  console.log(`[broker] ✓ CORS origin: ${process.env.CORS_ORIGIN || '*'}`);
  console.log(`[broker] ✓ Node version: ${process.version}`);
  console.log('='.repeat(60));
});

// Handle server errors
server.on('error', (err) => {
  console.error('[FATAL] Server error:', err);
  process.exit(1);
});
