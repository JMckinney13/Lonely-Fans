// Phase 1 + Phase 2 + Phase 3 – Auth + Profiles + Wallet
// Hybrid: real API for auth/wallet, localStorage fallback for other features during migration.

// Local dev (localhost) talks to a local backend; everything else uses production
const API_BASE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? 'http://localhost:3001/api'
  : 'https://lonely-fans.onrender.com/api';
const SESSION_KEY = 'lonelyfans_session';
const TOKEN_KEY = 'lonelyfans_token';

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}
function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch {
    throw new Error('Could not reach the server. It may be waking up — please try again in a few seconds.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token && path !== '/login') {
    // Expired or invalid token: drop the stale session so pages redirect to login
    clearSession();
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Escape user-supplied text before inserting it into innerHTML
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// SQLite timestamps are UTC without a zone ("YYYY-MM-DD HH:MM:SS")
function parseServerDate(value) {
  if (!value) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : value.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return isNaN(d) ? null : d;
}

// Redirects and returns null when the visitor may not view the page
function requireSession({ role, verified = true } = {}) {
  const session = getSession();
  if (!session || !getToken()) { location.replace('login.html'); return null; }
  if (verified && !session.ageVerified) { location.replace('age-verify.html'); return null; }
  if (role && session.role !== role) { location.replace('dashboard.html'); return null; }
  return session;
}

function getSession() {
  return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
}
function setSession(user) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(user));
}
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  clearToken();
}

async function register(email, password, role) {
  const data = await api('/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, role })
  });
  setToken(data.token);
  setSession(data.user);
  return data.user;
}

async function login(email, password) {
  const data = await api('/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
  setToken(data.token);
  setSession(data.user);
  return data.user;
}

function logout() {
  clearSession();
  window.location.href = 'index.html';
}

// Keep localStorage helpers for features not yet migrated
const STORAGE_KEY = 'lonelyfans_users';
const PROFILES_KEY = 'lonelyfans_profiles';
const WALLETS_KEY = 'lonelyfans_wallets';
const TRANSACTIONS_KEY = 'lonelyfans_transactions';

function getUsers() {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
}
function getProfiles() {
  return JSON.parse(localStorage.getItem(PROFILES_KEY) || '{}');
}
function saveProfiles(profiles) {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}
function getWallets() {
  return JSON.parse(localStorage.getItem(WALLETS_KEY) || '{}');
}
function saveWallets(wallets) {
  localStorage.setItem(WALLETS_KEY, JSON.stringify(wallets));
}
function getTransactions() {
  return JSON.parse(localStorage.getItem(TRANSACTIONS_KEY) || '[]');
}
function saveTransactions(txs) {
  localStorage.setItem(TRANSACTIONS_KEY, JSON.stringify(txs));
}

async function markAgeVerified(userId) {
  await api('/age-verify', { method: 'POST' });
  const session = getSession();
  if (session && session.id === userId) {
    session.ageVerified = true;
    setSession(session);
  }
}

// "Going live at…" label, e.g. "Sat, Oct 24, 8:00 PM"
function formatGoLive(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d) || d <= new Date()) return '';
  return d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function getCreators() {
  return api('/creators');
}

async function getProfile(userId) {
  try {
    if (userId) {
      return await api(`/profile/${userId}`);
    }
    return await api('/profile');
  } catch {
    const profiles = getProfiles();
    return profiles[userId] || null;
  }
}

async function saveProfile(userId, profileData) {
  await api('/profile', {
    method: 'PUT',
    body: JSON.stringify(profileData)
  });
  return profileData;
}

async function getBalance(userId) {
  try {
    const data = await api('/wallet');
    return data.balance;
  } catch {
    const wallets = getWallets();
    return wallets[userId]?.balance || 0;
  }
}

async function getUserTransactions(userId) {
  try {
    return await api('/transactions');
  } catch {
    return getTransactions().filter(tx => tx.userId === userId);
  }
}

function addTransaction(userId, type, amount, description) {
  const txs = getTransactions();
  const tx = {
    id: Date.now().toString(),
    userId,
    type,
    amount,
    description,
    timestamp: new Date().toISOString()
  };
  txs.unshift(tx);
  saveTransactions(txs);
  const wallets = getWallets();
  if (!wallets[userId]) wallets[userId] = { balance: 0 };
  wallets[userId].balance += amount;
  saveWallets(wallets);
  return tx;
}

// Follows (server-side). Follows saved by older versions in this browser are
// moved to the server once, then removed from localStorage.
async function migrateLocalFollows() {
  const session = getSession();
  const all = JSON.parse(localStorage.getItem('lf_follows') || '{}');
  const mine = session && Array.isArray(all[session.id]) ? all[session.id] : [];
  if (!mine.length) return;
  for (const creatorId of mine) {
    try { await api('/follows', { method: 'POST', body: JSON.stringify({ creatorId }) }); } catch {}
  }
  delete all[session.id];
  if (Object.keys(all).length) localStorage.setItem('lf_follows', JSON.stringify(all));
  else localStorage.removeItem('lf_follows');
}
async function getMyFollows() {
  await migrateLocalFollows();
  return api('/follows');
}
async function toggleFollow(fanId, creatorId) {
  const following = await isFollowing(fanId, creatorId);
  const data = following
    ? await api(`/follows/${encodeURIComponent(creatorId)}`, { method: 'DELETE' })
    : await api('/follows', { method: 'POST', body: JSON.stringify({ creatorId }) });
  return data.following;
}
async function isFollowing(fanId, creatorId) {
  await migrateLocalFollows();
  const data = await api(`/follows/${encodeURIComponent(creatorId)}`);
  return data.following;
}

// Daily streak (server-side, credits the real wallet)
async function claimDailyStreak(userId) {
  try {
    return await api('/streak/claim', { method: 'POST' });
  } catch {
    return { claimed: false, streak: 0 };
  }
}

async function buyCoins(amount, price) {
  const data = await api('/wallet/buy', {
    method: 'POST',
    body: JSON.stringify({ amount })
  });
  return data.balance;
}

const TIERS_KEY = 'lonelyfans_tiers';
const SUBS_KEY = 'lonelyfans_subscriptions';

function getTiers() {
  return JSON.parse(localStorage.getItem(TIERS_KEY) || '{}');
}

function saveTiers(tiers) {
  localStorage.setItem(TIERS_KEY, JSON.stringify(tiers));
}

function getSubscriptions() {
  return JSON.parse(localStorage.getItem(SUBS_KEY) || '[]');
}

function saveSubscriptions(subs) {
  localStorage.setItem(SUBS_KEY, JSON.stringify(subs));
}

async function getCreatorTiers(creatorId) {
  try {
    return await api(`/tiers/${creatorId}`);
  } catch {
    return [];
  }
}

async function saveCreatorTiers(creatorId, tierList) {
  // For simplicity, re-create via individual posts; or clear and re-add
  // Here we just support adding via the form
  return tierList;
}

async function isSubscribed(fanId, creatorId) {
  try {
    const data = await api(`/subscribed/${creatorId}`);
    return data.subscribed;
  } catch {
    return false;
  }
}

async function subscribe(fanId, creatorId, tierId, price) {
  await api('/subscribe', {
    method: 'POST',
    body: JSON.stringify({ creatorId, tierId })
  });
  return true;
}

function getMySubscriptions(fanId) {
  return getSubscriptions().filter(s => s.fanId === fanId && s.active);
}

const GOALS_KEY = 'lonelyfans_goals';
const CHAT_KEY = 'lonelyfans_chat';

function getGoals() {
  return JSON.parse(localStorage.getItem(GOALS_KEY) || '{}');
}
function saveGoals(goals) {
  localStorage.setItem(GOALS_KEY, JSON.stringify(goals));
}
function getChat() {
  return JSON.parse(localStorage.getItem(CHAT_KEY) || '{}');
}
function saveChat(chat) {
  localStorage.setItem(CHAT_KEY, JSON.stringify(chat));
}

async function getCreatorGoal(creatorId) {
  try {
    return await api(`/goals/${creatorId}`);
  } catch {
    return null;
  }
}

async function setCreatorGoal(creatorId, text, target) {
  await api('/goals', { method: 'POST', body: JSON.stringify({ text, target }) });
}

async function tipGoal(fanId, creatorId, amount) {
  await api('/goals/tip', { method: 'POST', body: JSON.stringify({ creatorId, amount }) });
}

async function addChatMessage(creatorId, username, text) {
  await api('/chat', { method: 'POST', body: JSON.stringify({ creatorId, text }) });
}

async function getChatMessages(creatorId) {
  try {
    return await api(`/chat/${creatorId}`);
  } catch {
    return [];
  }
}

async function setLive(creatorId, isLive, { keepalive = false } = {}) {
  await api('/live', { method: 'POST', body: JSON.stringify({ isLive }), keepalive });
}

async function isLive(creatorId) {
  try {
    const data = await api(`/live/${creatorId}`);
    return data.isLive;
  } catch {
    return false;
  }
}

// Earnings & payouts (server-side)
async function getEarnings() {
  // Payout history used to live in this browser only; it's now on the server
  localStorage.removeItem('lonelyfans_payouts');
  return api('/earnings');
}
async function getCreatorEarnings(creatorId) {
  const data = await getEarnings();
  return data.totals.available;
}
async function requestPayout(creatorId, amount) {
  if (!Number.isInteger(amount) || amount < 50) throw new Error('Minimum payout is 50 SparkCoins.');
  const data = await api('/payouts', { method: 'POST', body: JSON.stringify({ amount }) });
  return data.payout;
}
async function getCreatorPayouts(creatorId) {
  return api('/payouts');
}

const REPORTS_KEY = 'lonelyfans_reports';
const ATTEST_KEY = 'lonelyfans_attestations';

function getReports() {
  return JSON.parse(localStorage.getItem(REPORTS_KEY) || '[]');
}
function saveReports(reports) {
  localStorage.setItem(REPORTS_KEY, JSON.stringify(reports));
}
function submitReport(reporterId, targetId, type, reason) {
  const reports = getReports();
  reports.push({
    id: Date.now().toString(),
    reporterId,
    targetId,
    type, // 'user', 'content', 'stream'
    reason,
    status: 'pending',
    createdAt: new Date().toISOString()
  });
  saveReports(reports);
  return true;
}

function hasAttested(creatorId) {
  const attests = JSON.parse(localStorage.getItem(ATTEST_KEY) || '{}');
  return !!attests[creatorId];
}
function submitAttestation(creatorId) {
  const attests = JSON.parse(localStorage.getItem(ATTEST_KEY) || '{}');
  attests[creatorId] = {
    attestedAt: new Date().toISOString(),
    statement: 'I confirm all performers in my content are 18+ and I maintain required 2257 records.'
  };
  localStorage.setItem(ATTEST_KEY, JSON.stringify(attests));
}

window.LonelyFansAuth = {
  register, login, logout, getSession, markAgeVerified,
  getProfile, saveProfile, getBalance, buyCoins, getUserTransactions, addTransaction,
  getCreatorTiers, saveCreatorTiers, subscribe, isSubscribed,
  setCreatorGoal, getCreatorGoal, tipGoal,
  addChatMessage, getChatMessages, setLive, isLive, getUsers,
  toggleFollow, isFollowing, getMyFollows, claimDailyStreak, getCreators,
  escapeHtml, parseServerDate, formatGoLive, requireSession,
  getEarnings, getCreatorEarnings, requestPayout, getCreatorPayouts,
  submitReport, hasAttested, submitAttestation,
  API_BASE, api
};