// Phase 1 + Phase 2 + Phase 3 – Auth + Profiles + Wallet
// Hybrid: real API for auth/wallet, localStorage fallback for other features during migration.

const API_BASE = 'https://lonely-fans.onrender.com/api';
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
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
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

function markAgeVerified(userId) {
  const session = getSession();
  if (session && session.id === userId) {
    session.ageVerified = true;
    setSession(session);
  }
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

// Follow (localStorage for now)
function getFollows() {
  return JSON.parse(localStorage.getItem('lf_follows') || '{}');
}
function toggleFollow(fanId, creatorId) {
  const follows = getFollows();
  if (!follows[fanId]) follows[fanId] = [];
  const idx = follows[fanId].indexOf(creatorId);
  if (idx === -1) follows[fanId].push(creatorId);
  else follows[fanId].splice(idx, 1);
  localStorage.setItem('lf_follows', JSON.stringify(follows));
  return idx === -1;
}
function isFollowing(fanId, creatorId) {
  const follows = getFollows();
  return (follows[fanId] || []).includes(creatorId);
}

// Daily streak
function claimDailyStreak(userId) {
  const key = 'lf_streak_' + userId;
  const today = new Date().toDateString();
  const last = localStorage.getItem(key);
  if (last === today) return { claimed: false, streak: parseInt(localStorage.getItem(key + '_count') || '0', 10) };
  const streak = (last ? parseInt(localStorage.getItem(key + '_count') || '0', 10) : 0) + 1;
  localStorage.setItem(key, today);
  localStorage.setItem(key + '_count', streak);
  addTransaction(userId, 'streak', 10, 'Daily login streak');
  return { claimed: true, streak };
}

// Tip feed
function getRecentTips(creatorId) {
  return getTransactions().filter(tx => tx.type === 'tip' && tx.description.includes(creatorId)).slice(0, 5);
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
const LIVE_KEY = 'lonelyfans_live';

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
function getLiveStatus() {
  return JSON.parse(localStorage.getItem(LIVE_KEY) || '{}');
}
function setLive(creatorId, isLive) {
  const live = getLiveStatus();
  live[creatorId] = isLive;
  localStorage.setItem(LIVE_KEY, JSON.stringify(live));
}
function isLive(creatorId) {
  return !!getLiveStatus()[creatorId];
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

async function setLive(creatorId, isLive) {
  await api('/live', { method: 'POST', body: JSON.stringify({ isLive }) });
}

async function isLive(creatorId) {
  try {
    const data = await api(`/live/${creatorId}`);
    return data.isLive;
  } catch {
    return false;
  }
}

const PAYOUTS_KEY = 'lonelyfans_payouts';

function getPayouts() {
  return JSON.parse(localStorage.getItem(PAYOUTS_KEY) || '[]');
}
function savePayouts(payouts) {
  localStorage.setItem(PAYOUTS_KEY, JSON.stringify(payouts));
}

function getCreatorEarnings(creatorId) {
  const txs = getUserTransactions(creatorId);
  const earned = txs.filter(t => t.type === 'earning').reduce((sum, t) => sum + t.amount, 0);
  const paidOut = getPayouts()
    .filter(p => p.creatorId === creatorId && p.status === 'completed')
    .reduce((sum, p) => sum + p.amount, 0);
  return Math.max(0, earned - paidOut);
}

function requestPayout(creatorId, amount) {
  const available = getCreatorEarnings(creatorId);
  if (amount > available || amount < 50) {
    throw new Error('Minimum payout is 50 SparkCoins and cannot exceed available balance.');
  }
  const payouts = getPayouts();
  payouts.push({
    id: Date.now().toString(),
    creatorId,
    amount,
    status: 'pending', // in prototype we can auto-complete
    requestedAt: new Date().toISOString()
  });
  savePayouts(payouts);
  // Simulate instant completion for prototype
  payouts[payouts.length - 1].status = 'completed';
  payouts[payouts.length - 1].completedAt = new Date().toISOString();
  savePayouts(payouts);
  return payouts[payouts.length - 1];
}

function getCreatorPayouts(creatorId) {
  return getPayouts().filter(p => p.creatorId === creatorId);
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
  toggleFollow, isFollowing, claimDailyStreak, getRecentTips,
  getCreatorEarnings, requestPayout, getCreatorPayouts,
  submitReport, hasAttested, submitAttestation,
  API_BASE, api
};