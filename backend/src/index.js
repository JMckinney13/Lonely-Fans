const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

app.use(cors());
app.use(express.json());

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/lonelyfans';
// Render's external hostnames (*.render.com) require SSL; the internal hostname
// (dpg-xxx-a) is on the private network. PGSSL=true/false overrides.
const useSSL = process.env.PGSSL ? process.env.PGSSL === 'true' : /\.render\.com/.test(DATABASE_URL) || /sslmode=require/.test(DATABASE_URL);
const pool = new Pool({ connectionString: DATABASE_URL, ssl: useSSL ? { rejectUnauthorized: false } : false, max: 5 });

const q = async (sql, params = [], c = pool) => (await c.query(sql, params)).rows;
const one = async (sql, params = [], c = pool) => (await c.query(sql, params)).rows[0];
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; this.expose = true; } }
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const NOW = `(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))`;
const IN_30_DAYS = `(to_char((now() AT TIME ZONE 'UTC') + interval '30 days', 'YYYY-MM-DD HH24:MI:SS'))`;
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL,
    age_verified INTEGER DEFAULT 0, created_at TEXT DEFAULT ${NOW}
  );
  CREATE TABLE IF NOT EXISTS profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id), display_name TEXT, bio TEXT, banner_url TEXT,
    theme_color TEXT, accent_color TEXT, layout TEXT
  );
  CREATE TABLE IF NOT EXISTS wallets (user_id TEXT PRIMARY KEY REFERENCES users(id), balance INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), type TEXT, amount INTEGER,
    description TEXT, created_at TEXT DEFAULT ${NOW}
  );
  CREATE TABLE IF NOT EXISTS tiers (
    id TEXT PRIMARY KEY, creator_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
    price INTEGER NOT NULL, perks TEXT
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY, fan_id TEXT NOT NULL REFERENCES users(id), creator_id TEXT NOT NULL REFERENCES users(id),
    tier_id TEXT NOT NULL, price INTEGER, active INTEGER DEFAULT 1, started_at TEXT DEFAULT ${NOW}
  );
  CREATE TABLE IF NOT EXISTS goals (
    creator_id TEXT PRIMARY KEY REFERENCES users(id), text TEXT, target INTEGER,
    "current" INTEGER DEFAULT 0, completed INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY, creator_id TEXT NOT NULL REFERENCES users(id), username TEXT, text TEXT,
    is_sub INTEGER DEFAULT 0, created_at TEXT DEFAULT ${NOW}
  );
  CREATE TABLE IF NOT EXISTS chat_commands (
    id TEXT PRIMARY KEY, creator_id TEXT NOT NULL REFERENCES users(id), "trigger" TEXT NOT NULL, response TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_emotes (
    id TEXT PRIMARY KEY, creator_id TEXT NOT NULL REFERENCES users(id), code TEXT NOT NULL, emoji TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stream_settings (creator_id TEXT PRIMARY KEY REFERENCES users(id), slow_mode INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS chat_moderation (
    creator_id TEXT NOT NULL, user_id TEXT NOT NULL, type TEXT NOT NULL, expires_at TEXT,
    PRIMARY KEY (creator_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS streaks (user_id TEXT PRIMARY KEY, last_day TEXT, count INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS live_status (creator_id TEXT PRIMARY KEY REFERENCES users(id), is_live INTEGER DEFAULT 0);
  ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS user_id TEXT;
  CREATE TABLE IF NOT EXISTS follows (
    fan_id TEXT NOT NULL REFERENCES users(id), creator_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT DEFAULT ${NOW}, PRIMARY KEY (fan_id, creator_id)
  );
  CREATE TABLE IF NOT EXISTS payouts (
    id TEXT PRIMARY KEY, creator_id TEXT NOT NULL REFERENCES users(id), amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed', requested_at TEXT DEFAULT ${NOW}, completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_payouts_creator ON payouts(creator_id, requested_at);
  ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS expires_at TEXT;
  ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS canceled_at TEXT;
  UPDATE subscriptions SET expires_at = to_char(started_at::timestamp + interval '30 days', 'YYYY-MM-DD HH24:MI:SS')
    WHERE expires_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_subs_fan ON subscriptions(fan_id, creator_id);
  CREATE TABLE IF NOT EXISTS tips (
    id TEXT PRIMARY KEY, creator_id TEXT NOT NULL REFERENCES users(id), fan_id TEXT NOT NULL REFERENCES users(id),
    amount INTEGER NOT NULL, source TEXT NOT NULL, created_at TEXT DEFAULT ${NOW}
  );
  CREATE INDEX IF NOT EXISTS idx_tips_creator ON tips(creator_id, fan_id);
  CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_chat_creator ON chat_messages(creator_id, created_at);
`;

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
function requireCreator(req, res, next) {
  if (req.user.role !== 'creator') return res.status(403).json({ error: 'Creators only' });
  next();
}
// A subscription grants perks while active and not yet expired (monthly, 30 days)
const ACTIVE_SUB = `active = 1 AND (expires_at IS NULL OR expires_at > ${NOW})`;
const isPosInt = (n) => Number.isInteger(n) && n > 0;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.get('/api/health', (req, res) => res.json({ ok: true }));

const INSERT_TX = 'INSERT INTO transactions (id, user_id, type, amount, description) VALUES ($1, $2, $3, $4, $5)';
const profileOut = (p) => ({
  displayName: p.display_name, bio: p.bio, bannerUrl: p.banner_url,
  themeColor: p.theme_color, accentColor: p.accent_color, layout: p.layout
});

app.post('/api/register', h(async (req, res) => {
  const { email, password, role } = req.body;
  if (!email || !password || !role) return res.status(400).json({ error: 'Missing fields' });
  if (!EMAIL_RE.test(String(email))) return res.status(400).json({ error: 'Invalid email address' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!['creator', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const existing = await one('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) return res.status(400).json({ error: 'Email already registered' });

  const id = uuid();
  const hash = bcrypt.hashSync(password, 10);
  try {
    await tx(async (c) => {
      await c.query('INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, $4)', [id, email, hash, role]);
      await c.query('INSERT INTO wallets (user_id, balance) VALUES ($1, 0)', [id]);
      if (role === 'creator') {
        await c.query('INSERT INTO profiles (user_id, display_name, bio, theme_color, accent_color, layout) VALUES ($1, $2, $3, $4, $5, $6)',
          [id, email.split('@')[0], 'Welcome to my page!', '#ff6b6b', '#ff8e8e', 'classic']);
      }
    });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Email already registered' });
    throw e;
  }
  const token = jwt.sign({ id, email, role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id, email, role, ageVerified: false } });
}));

app.post('/api/login', h(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const user = await one('SELECT * FROM users WHERE email = $1', [email]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email: user.email, role: user.role, ageVerified: !!user.age_verified } });
}));

app.get('/api/me', authMiddleware, h(async (req, res) => {
  const user = await one('SELECT id, email, role, age_verified FROM users WHERE id = $1', [req.user.id]);
  res.json({ ...user, ageVerified: !!(user && user.age_verified) });
}));

app.post('/api/age-verify', authMiddleware, h(async (req, res) => {
  await q('UPDATE users SET age_verified = 1 WHERE id = $1', [req.user.id]);
  res.json({ ok: true });
}));

// Public creator directory (browse + "Live Now")
app.get('/api/creators', h(async (req, res) => {
  const rows = await q(`
    SELECT u.id, u.email, p.display_name, p.bio, p.theme_color, COALESCE(l.is_live, 0) AS is_live
    FROM users u
    LEFT JOIN profiles p ON p.user_id = u.id
    LEFT JOIN live_status l ON l.creator_id = u.id
    WHERE u.role = 'creator'
    ORDER BY is_live DESC, u.created_at DESC
    LIMIT 100
  `);
  res.json(rows.map(r => ({
    id: r.id,
    displayName: r.display_name || r.email.split('@')[0],
    bio: r.bio || '',
    themeColor: r.theme_color || '#ff6b6b',
    isLive: !!r.is_live
  })));
}));

// Follows
app.get('/api/follows', authMiddleware, h(async (req, res) => {
  const rows = await q(`
    SELECT u.id, u.email, p.display_name, p.bio, p.theme_color, COALESCE(l.is_live, 0) AS is_live, f.created_at
    FROM follows f JOIN users u ON u.id = f.creator_id
    LEFT JOIN profiles p ON p.user_id = u.id
    LEFT JOIN live_status l ON l.creator_id = u.id
    WHERE f.fan_id = $1 ORDER BY is_live DESC, f.created_at DESC`, [req.user.id]);
  res.json(rows.map(r => ({
    id: r.id, displayName: r.display_name || r.email.split('@')[0], bio: r.bio || '',
    themeColor: r.theme_color || '#ff6b6b', isLive: !!r.is_live, followedAt: r.created_at
  })));
}));

app.get('/api/follows/:creatorId', authMiddleware, h(async (req, res) => {
  const row = await one('SELECT 1 FROM follows WHERE fan_id = $1 AND creator_id = $2', [req.user.id, req.params.creatorId]);
  res.json({ following: !!row });
}));

app.post('/api/follows', authMiddleware, h(async (req, res) => {
  const { creatorId } = req.body;
  if (!creatorId || typeof creatorId !== 'string') return res.status(400).json({ error: 'Missing creator' });
  if (creatorId === req.user.id) return res.status(400).json({ error: "You can't follow yourself" });
  const creator = await one("SELECT id FROM users WHERE id = $1 AND role = 'creator'", [creatorId]);
  if (!creator) return res.status(404).json({ error: 'Creator not found' });
  await q('INSERT INTO follows (fan_id, creator_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, creatorId]);
  res.json({ ok: true, following: true });
}));

app.delete('/api/follows/:creatorId', authMiddleware, h(async (req, res) => {
  await q('DELETE FROM follows WHERE fan_id = $1 AND creator_id = $2', [req.user.id, req.params.creatorId]);
  res.json({ ok: true, following: false });
}));

// Daily login streak (server-side so the reward actually lands in the wallet)
app.post('/api/streak/claim', authMiddleware, h(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const result = await tx(async (c) => {
    await c.query('INSERT INTO streaks (user_id, last_day, count) VALUES ($1, NULL, 0) ON CONFLICT (user_id) DO NOTHING', [req.user.id]);
    const row = await one('SELECT * FROM streaks WHERE user_id = $1 FOR UPDATE', [req.user.id], c);
    if (row.last_day === today) return { claimed: false, streak: row.count };
    const count = row.last_day === yesterday ? row.count + 1 : 1;
    await c.query('UPDATE streaks SET last_day = $2, count = $3 WHERE user_id = $1', [req.user.id, today, count]);
    await c.query('UPDATE wallets SET balance = balance + 10 WHERE user_id = $1', [req.user.id]);
    await c.query(INSERT_TX, [uuid(), req.user.id, 'streak', 10, `Daily login streak (day ${count})`]);
    return { claimed: true, streak: count };
  });
  res.json(result);
}));

app.get('/api/wallet', authMiddleware, h(async (req, res) => {
  const wallet = await one('SELECT balance FROM wallets WHERE user_id = $1', [req.user.id]);
  res.json({ balance: wallet?.balance || 0 });
}));

app.post('/api/wallet/buy', authMiddleware, h(async (req, res) => {
  const { amount } = req.body;
  if (!isPosInt(amount) || amount > 100000) return res.status(400).json({ error: 'Invalid amount' });
  const wallet = await tx(async (c) => {
    await c.query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [amount, req.user.id]);
    await c.query(INSERT_TX, [uuid(), req.user.id, 'purchase', amount, `Purchased ${amount} SparkCoins`]);
    return one('SELECT balance FROM wallets WHERE user_id = $1', [req.user.id], c);
  });
  res.json({ balance: wallet.balance });
}));

app.get('/api/transactions', authMiddleware, h(async (req, res) => {
  const txs = await q('SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [req.user.id]);
  res.json(txs.map(t => ({
    id: t.id,
    type: t.type,
    amount: t.amount,
    description: t.description,
    timestamp: t.created_at
  })));
}));

app.get('/api/profile', authMiddleware, h(async (req, res) => {
  const profile = await one('SELECT * FROM profiles WHERE user_id = $1', [req.user.id]);
  if (!profile) return res.json(null);
  res.json(profileOut(profile));
}));

app.put('/api/profile', authMiddleware, h(async (req, res) => {
  const { displayName, bio, bannerUrl, themeColor, accentColor, layout } = req.body;
  await q(`INSERT INTO profiles (user_id, display_name, bio, banner_url, theme_color, accent_color, layout)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, bio = EXCLUDED.bio,
             banner_url = EXCLUDED.banner_url, theme_color = EXCLUDED.theme_color,
             accent_color = EXCLUDED.accent_color, layout = EXCLUDED.layout`,
    [req.user.id, displayName, bio, bannerUrl, themeColor, accentColor, layout]);
  res.json({ ok: true });
}));

app.get('/api/profile/:id', h(async (req, res) => {
  const profile = await one('SELECT * FROM profiles WHERE user_id = $1', [req.params.id]);
  if (!profile) return res.status(404).json({ error: 'Not found' });
  res.json(profileOut(profile));
}));

app.get('/api/tiers/:creatorId', h(async (req, res) => {
  const tiers = await q('SELECT * FROM tiers WHERE creator_id = $1', [req.params.creatorId]);
  res.json(tiers.map(t => ({ ...t, perks: t.perks ? JSON.parse(t.perks) : [] })));
}));

app.post('/api/tiers', authMiddleware, requireCreator, h(async (req, res) => {
  const { name, price, perks } = req.body;
  if (!name || !String(name).trim() || !price) return res.status(400).json({ error: 'Missing fields' });
  if (!isPosInt(price)) return res.status(400).json({ error: 'Price must be a whole number above 0' });
  const { c: count } = await one('SELECT COUNT(*)::int AS c FROM tiers WHERE creator_id = $1', [req.user.id]);
  if (count >= 3) return res.status(400).json({ error: 'Maximum 3 tiers' });
  const id = uuid();
  await q('INSERT INTO tiers (id, creator_id, name, price, perks) VALUES ($1, $2, $3, $4, $5)',
    [id, req.user.id, name, price, JSON.stringify(perks || [])]);
  res.json({ id, name, price, perks: perks || [] });
}));

app.delete('/api/tiers/:id', authMiddleware, h(async (req, res) => {
  await q('DELETE FROM tiers WHERE id = $1 AND creator_id = $2', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

app.post('/api/subscribe', authMiddleware, h(async (req, res) => {
  const { creatorId, tierId } = req.body;
  const tier = await one('SELECT * FROM tiers WHERE id = $1 AND creator_id = $2', [tierId, creatorId]);
  if (!tier) return res.status(404).json({ error: 'Tier not found' });
  if (creatorId === req.user.id) return res.status(400).json({ error: "You can't subscribe to yourself" });

  await tx(async (c) => {
    const wallet = await one('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [req.user.id], c);
    if (!wallet || wallet.balance < tier.price) throw new HttpError(400, 'Not enough SparkCoins');
    await c.query('UPDATE wallets SET balance = balance - $1 WHERE user_id = $2', [tier.price, req.user.id]);
    await c.query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [tier.price, creatorId]);
    await c.query(INSERT_TX, [uuid(), req.user.id, 'subscription', -tier.price, 'Subscribed to creator']);
    await c.query(INSERT_TX, [uuid(), creatorId, 'earning', tier.price, 'New subscriber']);
    await c.query('UPDATE subscriptions SET active = 0 WHERE fan_id = $1 AND creator_id = $2', [req.user.id, creatorId]);
    await c.query(`INSERT INTO subscriptions (id, fan_id, creator_id, tier_id, price, active, expires_at) VALUES ($1, $2, $3, $4, $5, 1, ${IN_30_DAYS})`,
      [uuid(), req.user.id, creatorId, tierId, tier.price]);
  });
  res.json({ ok: true });
}));

app.get('/api/subscribed/:creatorId', authMiddleware, h(async (req, res) => {
  const sub = await one(`SELECT id FROM subscriptions WHERE fan_id = $1 AND creator_id = $2 AND ${ACTIVE_SUB}`, [req.user.id, req.params.creatorId]);
  res.json({ subscribed: !!sub });
}));

// My subscriptions: latest subscription per creator, with status
const subOut = (r) => {
  const expired = !r.active || (r.expires_at && r.expires_at <= r.now);
  return {
    id: r.id, creatorId: r.creator_id, creatorName: r.display_name || (r.email ? r.email.split('@')[0] : 'Creator'),
    tierName: r.tier_name || 'Tier', price: r.price, startedAt: r.started_at, expiresAt: r.expires_at,
    canceled: !!r.canceled_at, status: expired ? 'expired' : r.canceled_at ? 'canceled' : 'active'
  };
};
const MY_SUBS_SQL = `
  SELECT DISTINCT ON (s.creator_id) s.*, t.name AS tier_name, p.display_name, u.email, ${NOW} AS now
  FROM subscriptions s
  JOIN users u ON u.id = s.creator_id
  LEFT JOIN tiers t ON t.id = s.tier_id
  LEFT JOIN profiles p ON p.user_id = s.creator_id
  WHERE s.fan_id = $1`;

app.get('/api/subscriptions', authMiddleware, h(async (req, res) => {
  const rows = await q(`${MY_SUBS_SQL} ORDER BY s.creator_id, s.started_at DESC, s.expires_at DESC NULLS LAST`, [req.user.id]);
  const order = { active: 0, canceled: 1, expired: 2 };
  res.json(rows.map(subOut).sort((a, b) => order[a.status] - order[b.status] || String(a.expiresAt).localeCompare(String(b.expiresAt))));
}));

// Renew: charges the subscription price again and extends it 30 days
// (from expiry if still active, otherwise from now)
app.post('/api/subscriptions/:id/renew', authMiddleware, h(async (req, res) => {
  await tx(async (c) => {
    const sub = await one('SELECT * FROM subscriptions WHERE id = $1 AND fan_id = $2 FOR UPDATE', [req.params.id, req.user.id], c);
    if (!sub) throw new HttpError(404, 'Subscription not found');
    const newer = await one('SELECT 1 FROM subscriptions WHERE fan_id = $1 AND creator_id = $2 AND started_at > $3', [req.user.id, sub.creator_id, sub.started_at], c);
    if (newer) throw new HttpError(400, 'This subscription was replaced by a newer one');
    if (!isPosInt(sub.price)) throw new HttpError(400, 'This subscription cannot be renewed');
    const wallet = await one('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [req.user.id], c);
    if (!wallet || wallet.balance < sub.price) throw new HttpError(400, 'Not enough SparkCoins');
    await c.query('UPDATE wallets SET balance = balance - $1 WHERE user_id = $2', [sub.price, req.user.id]);
    await c.query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [sub.price, sub.creator_id]);
    await c.query(INSERT_TX, [uuid(), req.user.id, 'subscription', -sub.price, 'Renewed subscription']);
    await c.query(INSERT_TX, [uuid(), sub.creator_id, 'earning', sub.price, 'Subscription renewal']);
    await c.query(`UPDATE subscriptions SET active = 1, canceled_at = NULL,
        expires_at = to_char(GREATEST(COALESCE(expires_at, ${NOW})::timestamp, ${NOW}::timestamp) + interval '30 days', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = $1`, [sub.id]);
  });
  const row = await one(`${MY_SUBS_SQL} AND s.id = $2`, [req.user.id, req.params.id]);
  res.json(subOut(row));
}));

// Cancel: no more renewals, but perks stay until expires_at
app.post('/api/subscriptions/:id/cancel', authMiddleware, h(async (req, res) => {
  const sub = await one('SELECT * FROM subscriptions WHERE id = $1 AND fan_id = $2', [req.params.id, req.user.id]);
  if (!sub) return res.status(404).json({ error: 'Subscription not found' });
  await q(`UPDATE subscriptions SET canceled_at = COALESCE(canceled_at, ${NOW}) WHERE id = $1`, [sub.id]);
  const row = await one(`${MY_SUBS_SQL} AND s.id = $2`, [req.user.id, req.params.id]);
  res.json(subOut(row));
}));

// Goals
app.get('/api/goals/:creatorId', h(async (req, res) => {
  const goal = await one('SELECT * FROM goals WHERE creator_id = $1', [req.params.creatorId]);
  res.json(goal || null);
}));

app.post('/api/goals', authMiddleware, requireCreator, h(async (req, res) => {
  const { text, target } = req.body;
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Goal text is required' });
  if (!isPosInt(target)) return res.status(400).json({ error: 'Target must be a whole number above 0' });
  await q(`INSERT INTO goals (creator_id, text, target, "current", completed) VALUES ($1, $2, $3, 0, 0)
           ON CONFLICT (creator_id) DO UPDATE SET text = EXCLUDED.text, target = EXCLUDED.target, "current" = 0, completed = 0`,
    [req.user.id, text, target]);
  res.json({ ok: true });
}));

app.post('/api/goals/tip', authMiddleware, h(async (req, res) => {
  const { creatorId, amount } = req.body;
  if (!isPosInt(amount)) return res.status(400).json({ error: 'Tip must be a whole number above 0' });
  if (creatorId === req.user.id) return res.status(400).json({ error: "You can't tip yourself" });
  await tx(async (c) => {
    const goal = await one('SELECT * FROM goals WHERE creator_id = $1 FOR UPDATE', [creatorId], c);
    if (!goal) throw new HttpError(404, 'No active goal');
    if (goal.completed) throw new HttpError(400, 'Goal already completed');
    const wallet = await one('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [req.user.id], c);
    if (!wallet || wallet.balance < amount) throw new HttpError(400, 'Not enough SparkCoins');
    const tipper = await one('SELECT email FROM users WHERE id = $1', [req.user.id], c);
    await c.query('UPDATE wallets SET balance = balance - $1 WHERE user_id = $2', [amount, req.user.id]);
    await c.query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [amount, creatorId]);
    await c.query(`UPDATE goals SET "current" = "current" + $1,
                     completed = CASE WHEN "current" + $1 >= target THEN 1 ELSE completed END
                   WHERE creator_id = $2`, [amount, creatorId]);
    await c.query(INSERT_TX, [uuid(), req.user.id, 'tip', -amount, 'Tipped a creator goal']);
    await c.query(INSERT_TX, [uuid(), creatorId, 'earning', amount, 'Goal tip received']);
    await c.query('INSERT INTO tips (id, creator_id, fan_id, amount, source) VALUES ($1, $2, $3, $4, $5)', [uuid(), creatorId, req.user.id, amount, 'goal']);
    await c.query('INSERT INTO chat_messages (id, creator_id, username, text) VALUES ($1, $2, $3, $4)',
      [uuid(), creatorId, 'Bot', `${tipper ? tipper.email.split('@')[0] : 'Someone'} tipped ${amount} SparkCoins!`]);
  });
  res.json({ ok: true });
}));

// Quick tip from live chat (separate from the goal)
app.post('/api/tips', authMiddleware, h(async (req, res) => {
  const { creatorId, amount } = req.body;
  if (!creatorId || typeof creatorId !== 'string') return res.status(400).json({ error: 'Missing creator' });
  if (!isPosInt(amount) || amount > 100000) return res.status(400).json({ error: 'Tip must be a whole number from 1 to 100,000' });
  if (creatorId === req.user.id) return res.status(400).json({ error: "You can't tip yourself" });
  const creator = await one("SELECT id FROM users WHERE id = $1 AND role = 'creator'", [creatorId]);
  if (!creator) return res.status(404).json({ error: 'Creator not found' });
  const mod = await one('SELECT type FROM chat_moderation WHERE creator_id = $1 AND user_id = $2', [creatorId, req.user.id]);
  if (mod && mod.type === 'ban') return res.status(403).json({ error: 'You are banned from this chat' });
  const balance = await tx(async (c) => {
    const wallet = await one('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [req.user.id], c);
    if (!wallet || wallet.balance < amount) throw new HttpError(400, 'Not enough SparkCoins');
    const tipper = await one('SELECT email FROM users WHERE id = $1', [req.user.id], c);
    await c.query('UPDATE wallets SET balance = balance - $1 WHERE user_id = $2', [amount, req.user.id]);
    await c.query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [amount, creatorId]);
    await c.query(INSERT_TX, [uuid(), req.user.id, 'tip', -amount, 'Tipped in live chat']);
    await c.query(INSERT_TX, [uuid(), creatorId, 'earning', amount, 'Chat tip received']);
    await c.query('INSERT INTO tips (id, creator_id, fan_id, amount, source) VALUES ($1, $2, $3, $4, $5)', [uuid(), creatorId, req.user.id, amount, 'chat']);
    await c.query('INSERT INTO chat_messages (id, creator_id, username, text) VALUES ($1, $2, $3, $4)',
      [uuid(), creatorId, 'Bot', `💰 ${tipper.email.split('@')[0]} tipped ${amount} SparkCoins!`]);
    return (await one('SELECT balance FROM wallets WHERE user_id = $1', [req.user.id], c)).balance;
  });
  res.json({ ok: true, balance });
}));

// Top 5 tippers for a creator (chat + goal tips); public like the chat
app.get('/api/tips/:creatorId/top', h(async (req, res) => {
  const rows = await q(`SELECT u.email, SUM(t.amount)::int AS total FROM tips t JOIN users u ON u.id = t.fan_id
    WHERE t.creator_id = $1 GROUP BY u.email ORDER BY total DESC, MIN(t.created_at) LIMIT 5`, [req.params.creatorId]);
  res.json(rows.map(r => ({ username: r.email.split('@')[0], total: r.total })));
}));

// Chat
const recentChat = async (creatorId, limit) =>
  (await q('SELECT * FROM chat_messages WHERE creator_id = $1 ORDER BY created_at DESC, id LIMIT $2', [creatorId, limit])).reverse();

app.get('/api/chat/:creatorId', h(async (req, res) => {
  res.json(await recentChat(req.params.creatorId, 50));
}));

app.get('/api/chat/:creatorId/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let busy = false;
  const send = async () => {
    if (busy) return;
    busy = true;
    try {
      const msgs = await recentChat(req.params.creatorId, 30);
      res.write(`data: ${JSON.stringify(msgs)}\n\n`);
    } catch (e) {
      console.error('stream error', e.message);
    } finally {
      busy = false;
    }
  };

  send();
  const interval = setInterval(send, 1500);
  req.on('close', () => clearInterval(interval));
});

// Emotes
app.get('/api/emotes/:creatorId', h(async (req, res) => {
  res.json(await q('SELECT * FROM chat_emotes WHERE creator_id = $1', [req.params.creatorId]));
}));

app.post('/api/emotes', authMiddleware, requireCreator, h(async (req, res) => {
  const { code, emoji } = req.body;
  if (!code || !emoji) return res.status(400).json({ error: 'Missing fields' });
  await q('INSERT INTO chat_emotes (id, creator_id, code, emoji) VALUES ($1, $2, $3, $4)', [uuid(), req.user.id, code.toLowerCase(), emoji]);
  res.json({ ok: true });
}));

// Slow mode
app.get('/api/settings/:creatorId', h(async (req, res) => {
  const s = await one('SELECT * FROM stream_settings WHERE creator_id = $1', [req.params.creatorId]);
  res.json(s || { slow_mode: 0 });
}));

app.post('/api/settings', authMiddleware, requireCreator, h(async (req, res) => {
  const { slow_mode } = req.body;
  await q(`INSERT INTO stream_settings (creator_id, slow_mode) VALUES ($1, $2)
           ON CONFLICT (creator_id) DO UPDATE SET slow_mode = EXCLUDED.slow_mode`, [req.user.id, slow_mode ? 1 : 0]);
  res.json({ ok: true });
}));

// Badge check (simple: any active sub = badge)
app.get('/api/badge/:creatorId', authMiddleware, h(async (req, res) => {
  const sub = await one(`SELECT 1 FROM subscriptions WHERE fan_id = $1 AND creator_id = $2 AND ${ACTIVE_SUB}`, [req.user.id, req.params.creatorId]);
  res.json({ hasBadge: !!sub });
}));

// Chat commands
app.get('/api/commands/:creatorId', h(async (req, res) => {
  res.json(await q('SELECT * FROM chat_commands WHERE creator_id = $1', [req.params.creatorId]));
}));

app.post('/api/commands', authMiddleware, requireCreator, h(async (req, res) => {
  const { trigger, response } = req.body;
  if (!trigger || !response) return res.status(400).json({ error: 'Missing fields' });
  await q('INSERT INTO chat_commands (id, creator_id, "trigger", response) VALUES ($1, $2, $3, $4)', [uuid(), req.user.id, trigger.toLowerCase(), response]);
  res.json({ ok: true });
}));

// Moderation
const UPSERT_MOD = `INSERT INTO chat_moderation (creator_id, user_id, type, expires_at) VALUES ($1, $2, $3, $4)
  ON CONFLICT (creator_id, user_id) DO UPDATE SET type = EXCLUDED.type, expires_at = EXCLUDED.expires_at`;

async function requireChatUser(creatorId, userId) {
  if (!userId || typeof userId !== 'string') throw new HttpError(400, 'Missing user');
  if (userId === creatorId) throw new HttpError(400, "You can't moderate yourself");
  const u = await one('SELECT id FROM users WHERE id = $1', [userId]);
  if (!u) throw new HttpError(404, 'User not found');
}

app.post('/api/mod/timeout', authMiddleware, requireCreator, h(async (req, res) => {
  const { userId } = req.body;
  const minutes = req.body.minutes === undefined ? 5 : req.body.minutes;
  if (!isPosInt(minutes) || minutes > 1440) return res.status(400).json({ error: 'Minutes must be a whole number from 1 to 1440' });
  await requireChatUser(req.user.id, userId);
  const expires = new Date(Date.now() + minutes * 60000).toISOString();
  await q(UPSERT_MOD, [req.user.id, userId, 'timeout', expires]);
  res.json({ ok: true, expiresAt: expires });
}));

app.post('/api/mod/ban', authMiddleware, requireCreator, h(async (req, res) => {
  const { userId } = req.body;
  await requireChatUser(req.user.id, userId);
  await q(UPSERT_MOD, [req.user.id, userId, 'ban', null]);
  res.json({ ok: true });
}));

app.post('/api/mod/unban', authMiddleware, requireCreator, h(async (req, res) => {
  const { userId } = req.body;
  if (!userId || typeof userId !== 'string') return res.status(400).json({ error: 'Missing user' });
  await q('DELETE FROM chat_moderation WHERE creator_id = $1 AND user_id = $2', [req.user.id, userId]);
  res.json({ ok: true });
}));

// Banned users and active timeouts for the creator's controls
app.get('/api/mod/list', authMiddleware, requireCreator, h(async (req, res) => {
  const rows = await q(`SELECT m.user_id, m.type, m.expires_at, u.email FROM chat_moderation m
    JOIN users u ON u.id = m.user_id WHERE m.creator_id = $1 ORDER BY m.type, u.email`, [req.user.id]);
  const now = new Date();
  res.json(rows.filter(r => r.type === 'ban' || new Date(r.expires_at) > now).map(r => ({
    userId: r.user_id, username: r.email.split('@')[0], type: r.type, expiresAt: r.expires_at
  })));
}));

// Lets a viewer see up front whether they can chat
app.get('/api/mod/status/:creatorId', authMiddleware, h(async (req, res) => {
  const mod = await one('SELECT * FROM chat_moderation WHERE creator_id = $1 AND user_id = $2', [req.params.creatorId, req.user.id]);
  const banned = !!(mod && mod.type === 'ban');
  const timedOutUntil = mod && mod.type === 'timeout' && new Date(mod.expires_at) > new Date() ? mod.expires_at : null;
  res.json({ banned, timedOutUntil });
}));

// Enhanced chat post with command & mod check
app.post('/api/chat', authMiddleware, h(async (req, res) => {
  const { creatorId } = req.body;
  const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
  if (!creatorId) return res.status(400).json({ error: 'Missing creator' });
  if (!text) return res.status(400).json({ error: 'Message is empty' });
  if (text.length > 500) return res.status(400).json({ error: 'Message is too long (500 max)' });
  const user = await one('SELECT email FROM users WHERE id = $1', [req.user.id]);
  const username = user.email.split('@')[0];

  // Check moderation
  const mod = await one('SELECT * FROM chat_moderation WHERE creator_id = $1 AND user_id = $2', [creatorId, req.user.id]);
  if (mod) {
    if (mod.type === 'ban') return res.status(403).json({ error: 'You are banned from this chat' });
    if (mod.type === 'timeout' && new Date(mod.expires_at) > new Date()) {
      const mins = Math.max(1, Math.ceil((new Date(mod.expires_at) - Date.now()) / 60000));
      return res.status(403).json({ error: `You are timed out from this chat for ${mins} more minute${mins === 1 ? '' : 's'}` });
    }
  }

  // Check commands
  if (text.startsWith('!')) {
    const trigger = text.split(' ')[0].toLowerCase();
    const cmd = await one('SELECT response FROM chat_commands WHERE creator_id = $1 AND "trigger" = $2', [creatorId, trigger]);
    if (cmd) {
      await q('INSERT INTO chat_messages (id, creator_id, username, text) VALUES ($1, $2, $3, $4)', [uuid(), creatorId, 'Bot', cmd.response]);
      return res.json({ ok: true, bot: true });
    }
  }

  // Check slow mode (simple last-message timestamp)
  const settings = await one('SELECT slow_mode FROM stream_settings WHERE creator_id = $1', [creatorId]);
  if (settings && settings.slow_mode) {
    const last = await one('SELECT created_at FROM chat_messages WHERE creator_id = $1 AND username = $2 ORDER BY created_at DESC LIMIT 1', [creatorId, username]);
    if (last) {
      // created_at is stored as UTC 'YYYY-MM-DD HH:MM:SS' without a zone marker
      const diff = (Date.now() - new Date(last.created_at.replace(' ', 'T') + 'Z').getTime()) / 1000;
      if (diff < 5) return res.status(429).json({ error: 'Slow mode: wait a few seconds' });
    }
  }

  // Check if subscriber
  const isSub = await one(`SELECT 1 FROM subscriptions WHERE fan_id = $1 AND creator_id = $2 AND ${ACTIVE_SUB}`, [req.user.id, creatorId]);

  await q('INSERT INTO chat_messages (id, creator_id, username, text, is_sub, user_id) VALUES ($1, $2, $3, $4, $5, $6)', [uuid(), creatorId, username, text, isSub ? 1 : 0, req.user.id]);
  res.json({ ok: true });
}));

// Earnings & payouts (creator only). Earnings are 'earning' transactions,
// classified by source; payouts are recorded in the payouts table.
const EARNING_KIND = `CASE WHEN description ILIKE '%tip%' THEN 'tip'
  WHEN description ILIKE '%subscri%' THEN 'subscription' ELSE 'other' END`;
async function earningsSummary(creatorId, c = pool) {
  const t = await one(`SELECT
      COALESCE(SUM(amount) FILTER (WHERE ${EARNING_KIND} = 'subscription'), 0)::int AS subscriptions,
      COALESCE(SUM(amount) FILTER (WHERE ${EARNING_KIND} = 'tip'), 0)::int AS tips,
      COALESCE(SUM(amount) FILTER (WHERE ${EARNING_KIND} = 'other'), 0)::int AS other,
      COUNT(*) FILTER (WHERE ${EARNING_KIND} = 'subscription')::int AS subscription_count,
      COUNT(*) FILTER (WHERE ${EARNING_KIND} = 'tip')::int AS tip_count
    FROM transactions WHERE user_id = $1 AND type = 'earning'`, [creatorId], c);
  const p = await one(`SELECT COALESCE(SUM(amount), 0)::int AS paid FROM payouts WHERE creator_id = $1 AND status IN ('pending', 'completed')`, [creatorId], c);
  const w = await one('SELECT balance FROM wallets WHERE user_id = $1', [creatorId], c);
  const earned = t.subscriptions + t.tips + t.other;
  // Can't pay out more than was earned, nor more than is still in the wallet
  const available = Math.max(0, Math.min(earned - p.paid, w ? w.balance : 0));
  return {
    subscriptions: t.subscriptions, tips: t.tips, other: t.other,
    subscriptionCount: t.subscription_count, tipCount: t.tip_count,
    earned, paidOut: p.paid, available
  };
}
const payoutOut = (p) => ({ id: p.id, amount: p.amount, status: p.status, requestedAt: p.requested_at, completedAt: p.completed_at });

app.get('/api/earnings', authMiddleware, requireCreator, h(async (req, res) => {
  const [totals, recent, payouts] = await Promise.all([
    earningsSummary(req.user.id),
    q(`SELECT id, amount, description, created_at, ${EARNING_KIND} AS kind FROM transactions
       WHERE user_id = $1 AND type = 'earning' ORDER BY created_at DESC LIMIT 50`, [req.user.id]),
    q('SELECT * FROM payouts WHERE creator_id = $1 ORDER BY requested_at DESC LIMIT 50', [req.user.id])
  ]);
  res.json({
    totals,
    earnings: recent.map(r => ({ id: r.id, kind: r.kind, amount: r.amount, description: r.description, timestamp: r.created_at })),
    payouts: payouts.map(payoutOut)
  });
}));

app.get('/api/payouts', authMiddleware, requireCreator, h(async (req, res) => {
  const rows = await q('SELECT * FROM payouts WHERE creator_id = $1 ORDER BY requested_at DESC LIMIT 50', [req.user.id]);
  res.json(rows.map(payoutOut));
}));

const MIN_PAYOUT = 50;
app.post('/api/payouts', authMiddleware, requireCreator, h(async (req, res) => {
  const { amount } = req.body;
  if (!isPosInt(amount) || amount < MIN_PAYOUT) return res.status(400).json({ error: `Minimum payout is ${MIN_PAYOUT} SparkCoins` });
  const payout = await tx(async (c) => {
    await c.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    const { available } = await earningsSummary(req.user.id, c);
    if (amount > available) throw new HttpError(400, `Not enough available earnings (available: ${available} SparkCoins)`);
    const id = uuid();
    // Prototype: payouts complete instantly; a real processor would leave this 'pending'
    await c.query(`INSERT INTO payouts (id, creator_id, amount, status, completed_at) VALUES ($1, $2, $3, 'completed', ${NOW})`, [id, req.user.id, amount]);
    await c.query('UPDATE wallets SET balance = balance - $1 WHERE user_id = $2', [amount, req.user.id]);
    await c.query(INSERT_TX, [uuid(), req.user.id, 'payout', -amount, `Payout of ${amount} SparkCoins`]);
    return one('SELECT * FROM payouts WHERE id = $1', [id], c);
  });
  res.json({ payout: payoutOut(payout), totals: await earningsSummary(req.user.id) });
}));

// Live status
app.post('/api/live', authMiddleware, requireCreator, h(async (req, res) => {
  const { isLive } = req.body;
  await q(`INSERT INTO live_status (creator_id, is_live) VALUES ($1, $2)
           ON CONFLICT (creator_id) DO UPDATE SET is_live = EXCLUDED.is_live`, [req.user.id, isLive ? 1 : 0]);
  res.json({ ok: true });
}));

app.get('/api/live/:creatorId', h(async (req, res) => {
  const row = await one('SELECT is_live FROM live_status WHERE creator_id = $1', [req.params.creatorId]);
  res.json({ isLive: !!(row && row.is_live) });
}));

// JSON error responses instead of Express's HTML error page
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(err.status || 500).json({ error: err.status === 400 ? 'Invalid request body' : 'Server error' });
});

async function start() {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(SCHEMA);
      break;
    } catch (e) {
      if (attempt >= 10) throw e;
      console.error(`DB init failed (attempt ${attempt}): ${e.message}; retrying`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  app.listen(PORT, () => console.log(`Lonely Fans API running on http://localhost:${PORT}`));
}
start().catch((e) => { console.error('Fatal startup error', e); process.exit(1); });
