const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

app.use(cors());
app.use(express.json());

const db = new Database('lonelyfans.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    age_verified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS profiles (
    user_id TEXT PRIMARY KEY,
    display_name TEXT,
    bio TEXT,
    banner_url TEXT,
    theme_color TEXT,
    accent_color TEXT,
    layout TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS wallets (
    user_id TEXT PRIMARY KEY,
    balance INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT,
    amount INTEGER,
    description TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS tiers (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    perks TEXT,
    FOREIGN KEY (creator_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    fan_id TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    tier_id TEXT NOT NULL,
    price INTEGER,
    active INTEGER DEFAULT 1,
    started_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (fan_id) REFERENCES users(id),
    FOREIGN KEY (creator_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS goals (
    creator_id TEXT PRIMARY KEY,
    text TEXT,
    target INTEGER,
    current INTEGER DEFAULT 0,
    completed INTEGER DEFAULT 0,
    FOREIGN KEY (creator_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL,
    username TEXT,
    text TEXT,
    is_sub INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (creator_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS chat_commands (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL,
    trigger TEXT NOT NULL,
    response TEXT NOT NULL,
    FOREIGN KEY (creator_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS chat_emotes (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL,
    code TEXT NOT NULL,
    emoji TEXT NOT NULL,
    FOREIGN KEY (creator_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS stream_settings (
    creator_id TEXT PRIMARY KEY,
    slow_mode INTEGER DEFAULT 0,
    FOREIGN KEY (creator_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS chat_moderation (
    creator_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    expires_at TEXT,
    PRIMARY KEY (creator_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS live_status (
    creator_id TEXT PRIMARY KEY,
    is_live INTEGER DEFAULT 0,
    FOREIGN KEY (creator_id) REFERENCES users(id)
  );
`);

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token' });
  try {
    const token = header.replace('Bearer ', '');
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/register', (req, res) => {
  const { email, password, role } = req.body;
  if (!email || !password || !role) return res.status(400).json({ error: 'Missing fields' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(400).json({ error: 'Email already registered' });

  const id = uuid();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)').run(id, email, hash, role);
  db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?, 0)').run(id);
  if (role === 'creator') {
    db.prepare('INSERT INTO profiles (user_id, display_name, bio, theme_color, accent_color, layout) VALUES (?, ?, ?, ?, ?, ?)').run(
      id, email.split('@')[0], 'Welcome to my page!', '#ff6b6b', '#ff8e8e', 'classic'
    );
  }
  const token = jwt.sign({ id, email, role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id, email, role, ageVerified: false } });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email: user.email, role: user.role, ageVerified: !!user.age_verified } });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, email, role, age_verified FROM users WHERE id = ?').get(req.user.id);
  res.json({ ...user, ageVerified: !!user.age_verified });
});

app.get('/api/wallet', authMiddleware, (req, res) => {
  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(req.user.id);
  res.json({ balance: wallet?.balance || 0 });
});

app.post('/api/wallet/buy', authMiddleware, (req, res) => {
  const { amount } = req.body;
  if (!amount || amount < 1) return res.status(400).json({ error: 'Invalid amount' });
  db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(amount, req.user.id);
  db.prepare('INSERT INTO transactions (id, user_id, type, amount, description) VALUES (?, ?, ?, ?, ?)').run(
    uuid(), req.user.id, 'purchase', amount, `Purchased ${amount} SparkCoins`
  );
  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(req.user.id);
  res.json({ balance: wallet.balance });
});

app.get('/api/transactions', authMiddleware, (req, res) => {
  const txs = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(req.user.id);
  res.json(txs.map(t => ({
    id: t.id,
    type: t.type,
    amount: t.amount,
    description: t.description,
    timestamp: t.created_at
  })));
});

app.get('/api/profile', authMiddleware, (req, res) => {
  const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(req.user.id);
  if (!profile) return res.json(null);
  res.json({
    displayName: profile.display_name,
    bio: profile.bio,
    bannerUrl: profile.banner_url,
    themeColor: profile.theme_color,
    accentColor: profile.accent_color,
    layout: profile.layout
  });
});

app.put('/api/profile', authMiddleware, (req, res) => {
  const { displayName, bio, bannerUrl, themeColor, accentColor, layout } = req.body;
  const existing = db.prepare('SELECT user_id FROM profiles WHERE user_id = ?').get(req.user.id);
  if (existing) {
    db.prepare(`UPDATE profiles SET display_name=?, bio=?, banner_url=?, theme_color=?, accent_color=?, layout=? WHERE user_id=?`).run(
      displayName, bio, bannerUrl, themeColor, accentColor, layout, req.user.id
    );
  } else {
    db.prepare(`INSERT INTO profiles (user_id, display_name, bio, banner_url, theme_color, accent_color, layout) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      req.user.id, displayName, bio, bannerUrl, themeColor, accentColor, layout
    );
  }
  res.json({ ok: true });
});

app.get('/api/profile/:id', (req, res) => {
  const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Not found' });
  res.json({
    displayName: profile.display_name,
    bio: profile.bio,
    bannerUrl: profile.banner_url,
    themeColor: profile.theme_color,
    accentColor: profile.accent_color,
    layout: profile.layout
  });
});

app.get('/api/tiers/:creatorId', (req, res) => {
  const tiers = db.prepare('SELECT * FROM tiers WHERE creator_id = ?').all(req.params.creatorId);
  res.json(tiers.map(t => ({ ...t, perks: t.perks ? JSON.parse(t.perks) : [] })));
});

app.post('/api/tiers', authMiddleware, (req, res) => {
  const { name, price, perks } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Missing fields' });
  const count = db.prepare('SELECT COUNT(*) as c FROM tiers WHERE creator_id = ?').get(req.user.id).c;
  if (count >= 3) return res.status(400).json({ error: 'Maximum 3 tiers' });
  const id = uuid();
  db.prepare('INSERT INTO tiers (id, creator_id, name, price, perks) VALUES (?, ?, ?, ?, ?)').run(
    id, req.user.id, name, price, JSON.stringify(perks || [])
  );
  res.json({ id, name, price, perks: perks || [] });
});

app.delete('/api/tiers/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM tiers WHERE id = ? AND creator_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/subscribe', authMiddleware, (req, res) => {
  const { creatorId, tierId } = req.body;
  const tier = db.prepare('SELECT * FROM tiers WHERE id = ? AND creator_id = ?').get(tierId, creatorId);
  if (!tier) return res.status(404).json({ error: 'Tier not found' });

  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(req.user.id);
  if (!wallet || wallet.balance < tier.price) return res.status(400).json({ error: 'Not enough SparkCoins' });

  db.prepare('UPDATE wallets SET balance = balance - ? WHERE user_id = ?').run(tier.price, req.user.id);
  db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(tier.price, creatorId);
  db.prepare('INSERT INTO transactions (id, user_id, type, amount, description) VALUES (?, ?, ?, ?, ?)').run(
    uuid(), req.user.id, 'subscription', -tier.price, `Subscribed to creator`
  );
  db.prepare('INSERT INTO transactions (id, user_id, type, amount, description) VALUES (?, ?, ?, ?, ?)').run(
    uuid(), creatorId, 'earning', tier.price, `New subscriber`
  );

  db.prepare('UPDATE subscriptions SET active = 0 WHERE fan_id = ? AND creator_id = ?').run(req.user.id, creatorId);
  const subId = uuid();
  db.prepare('INSERT INTO subscriptions (id, fan_id, creator_id, tier_id, price, active) VALUES (?, ?, ?, ?, ?, 1)').run(
    subId, req.user.id, creatorId, tierId, tier.price
  );
  res.json({ ok: true });
});

app.get('/api/subscribed/:creatorId', authMiddleware, (req, res) => {
  const sub = db.prepare('SELECT id FROM subscriptions WHERE fan_id = ? AND creator_id = ? AND active = 1').get(req.user.id, req.params.creatorId);
  res.json({ subscribed: !!sub });
});

// Goals
app.get('/api/goals/:creatorId', (req, res) => {
  const goal = db.prepare('SELECT * FROM goals WHERE creator_id = ?').get(req.params.creatorId);
  res.json(goal || null);
});

app.post('/api/goals', authMiddleware, (req, res) => {
  const { text, target } = req.body;
  db.prepare('INSERT OR REPLACE INTO goals (creator_id, text, target, current, completed) VALUES (?, ?, ?, 0, 0)').run(req.user.id, text, target);
  res.json({ ok: true });
});

app.post('/api/goals/tip', authMiddleware, (req, res) => {
  const { creatorId, amount } = req.body;
  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(req.user.id);
  if (!wallet || wallet.balance < amount) return res.status(400).json({ error: 'Not enough SparkCoins' });
  db.prepare('UPDATE wallets SET balance = balance - ? WHERE user_id = ?').run(amount, req.user.id);
  db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(amount, creatorId);
  db.prepare('UPDATE goals SET current = current + ? WHERE creator_id = ?').run(amount, creatorId);
  const goal = db.prepare('SELECT * FROM goals WHERE creator_id = ?').get(creatorId);
  if (goal && goal.current >= goal.target) {
    db.prepare('UPDATE goals SET completed = 1 WHERE creator_id = ?').run(creatorId);
  }
  res.json({ ok: true });
});

// Chat
app.get('/api/chat/:creatorId', (req, res) => {
  const msgs = db.prepare('SELECT * FROM chat_messages WHERE creator_id = ? ORDER BY created_at DESC LIMIT 50').all(req.params.creatorId);
  res.json(msgs.reverse());
});

app.get('/api/chat/:creatorId/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = () => {
    const msgs = db.prepare('SELECT * FROM chat_messages WHERE creator_id = ? ORDER BY created_at DESC LIMIT 30').all(req.params.creatorId);
    res.write(`data: ${JSON.stringify(msgs.reverse())}\n\n`);
  };

  send();
  const interval = setInterval(send, 1500);
  req.on('close', () => clearInterval(interval));
});

// Emotes
app.get('/api/emotes/:creatorId', (req, res) => {
  const emotes = db.prepare('SELECT * FROM chat_emotes WHERE creator_id = ?').all(req.params.creatorId);
  res.json(emotes);
});

app.post('/api/emotes', authMiddleware, (req, res) => {
  const { code, emoji } = req.body;
  if (!code || !emoji) return res.status(400).json({ error: 'Missing fields' });
  db.prepare('INSERT OR REPLACE INTO chat_emotes (id, creator_id, code, emoji) VALUES (?, ?, ?, ?)').run(uuid(), req.user.id, code.toLowerCase(), emoji);
  res.json({ ok: true });
});

// Slow mode
app.get('/api/settings/:creatorId', (req, res) => {
  const s = db.prepare('SELECT * FROM stream_settings WHERE creator_id = ?').get(req.params.creatorId);
  res.json(s || { slow_mode: 0 });
});

app.post('/api/settings', authMiddleware, (req, res) => {
  const { slow_mode } = req.body;
  db.prepare('INSERT OR REPLACE INTO stream_settings (creator_id, slow_mode) VALUES (?, ?)').run(req.user.id, slow_mode ? 1 : 0);
  res.json({ ok: true });
});

// Badge check (simple: any active sub = badge)
app.get('/api/badge/:creatorId', authMiddleware, (req, res) => {
  const sub = db.prepare('SELECT 1 FROM subscriptions WHERE fan_id = ? AND creator_id = ? AND active = 1').get(req.user.id, req.params.creatorId);
  res.json({ hasBadge: !!sub });
});

// Chat commands
app.get('/api/commands/:creatorId', (req, res) => {
  const cmds = db.prepare('SELECT * FROM chat_commands WHERE creator_id = ?').all(req.params.creatorId);
  res.json(cmds);
});

app.post('/api/commands', authMiddleware, (req, res) => {
  const { trigger, response } = req.body;
  if (!trigger || !response) return res.status(400).json({ error: 'Missing fields' });
  const id = uuid();
  db.prepare('INSERT OR REPLACE INTO chat_commands (id, creator_id, trigger, response) VALUES (?, ?, ?, ?)').run(id, req.user.id, trigger.toLowerCase(), response);
  res.json({ ok: true });
});

// Moderation
app.post('/api/mod/timeout', authMiddleware, (req, res) => {
  const { userId, minutes } = req.body;
  const expires = new Date(Date.now() + (minutes || 5) * 60000).toISOString();
  db.prepare('INSERT OR REPLACE INTO chat_moderation (creator_id, user_id, type, expires_at) VALUES (?, ?, ?, ?)').run(req.user.id, userId, 'timeout', expires);
  res.json({ ok: true });
});

app.post('/api/mod/ban', authMiddleware, (req, res) => {
  const { userId } = req.body;
  db.prepare('INSERT OR REPLACE INTO chat_moderation (creator_id, user_id, type, expires_at) VALUES (?, ?, ?, ?)').run(req.user.id, userId, 'ban', null);
  res.json({ ok: true });
});

// Enhanced chat post with command & mod check
app.post('/api/chat', authMiddleware, (req, res) => {
  const { creatorId, text } = req.body;
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
  const username = user.email.split('@')[0];

  // Check moderation
  const mod = db.prepare('SELECT * FROM chat_moderation WHERE creator_id = ? AND user_id = ?').get(creatorId, req.user.id);
  if (mod) {
    if (mod.type === 'ban') return res.status(403).json({ error: 'You are banned from this chat' });
    if (mod.type === 'timeout' && new Date(mod.expires_at) > new Date()) {
      return res.status(403).json({ error: 'You are timed out' });
    }
  }

  // Check commands
  if (text.startsWith('!')) {
    const trigger = text.split(' ')[0].toLowerCase();
    const cmd = db.prepare('SELECT response FROM chat_commands WHERE creator_id = ? AND trigger = ?').get(creatorId, trigger);
    if (cmd) {
      db.prepare('INSERT INTO chat_messages (id, creator_id, username, text) VALUES (?, ?, ?, ?)').run(uuid(), creatorId, 'Bot', cmd.response);
      return res.json({ ok: true, bot: true });
    }
  }

  // Check slow mode (simple last-message timestamp)
  const settings = db.prepare('SELECT slow_mode FROM stream_settings WHERE creator_id = ?').get(creatorId);
  if (settings && settings.slow_mode) {
    const last = db.prepare('SELECT created_at FROM chat_messages WHERE creator_id = ? AND username = ? ORDER BY created_at DESC LIMIT 1').get(creatorId, username);
    if (last) {
      const diff = (Date.now() - new Date(last.created_at).getTime()) / 1000;
      if (diff < 5) return res.status(429).json({ error: 'Slow mode: wait a few seconds' });
    }
  }

  // Check if subscriber
  const isSub = db.prepare('SELECT 1 FROM subscriptions WHERE fan_id = ? AND creator_id = ? AND active = 1').get(req.user.id, creatorId);

  db.prepare('INSERT INTO chat_messages (id, creator_id, username, text, is_sub) VALUES (?, ?, ?, ?, ?)').run(uuid(), creatorId, username, text, isSub ? 1 : 0);
  res.json({ ok: true });
});

// Live status
app.post('/api/live', authMiddleware, (req, res) => {
  const { isLive } = req.body;
  db.prepare('INSERT OR REPLACE INTO live_status (creator_id, is_live) VALUES (?, ?)').run(req.user.id, isLive ? 1 : 0);
  res.json({ ok: true });
});

app.get('/api/live/:creatorId', (req, res) => {
  const row = db.prepare('SELECT is_live FROM live_status WHERE creator_id = ?').get(req.params.creatorId);
  res.json({ isLive: !!(row && row.is_live) });
});

app.listen(PORT, () => console.log(`Lonely Fans API running on http://localhost:${PORT}`));
