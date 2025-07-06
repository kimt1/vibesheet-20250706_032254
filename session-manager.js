const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSIONS_FILE = path.resolve(__dirname, './sessions.json.enc');
const COOKIES_FILE = path.resolve(__dirname, './cookies.json.enc');

const LOCK_RETRY_INTERVAL = 10; // ms
const LOCK_TIMEOUT = 3000; // ms

const SESSION_LIFETIME = 7 * 24 * 60 * 60 * 1000; // 7 days in ms, adjustable

// ------------------------------------------------------------
// Encryption configuration (simple symmetric for demonstration)
// In production, retrieve this key from a secure vault/env var
// ------------------------------------------------------------
const SECRET_KEY = process.env.FORM_MASTER_SESSKEY || crypto.createHash('sha256').update('default_session_secret', 'utf8').digest().slice(0, 32); // 256-bit

function encryptData(data) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET_KEY, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(data), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptData(str) {
  const buf = Buffer.from(str, 'base64');
  const iv = buf.slice(0, 16);
  const tag = buf.slice(16, 32);
  const enc = buf.slice(32);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', SECRET_KEY, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(dec.toString('utf8'));
  } catch (e) {
    // Corrupt data or tampered file
    return {};
  }
}

// -------------------
// File lock routines
// -------------------
function lockFile(file) {
  const lock = file + '.lock';
  const start = Date.now();
  while (fs.existsSync(lock)) {
    if (Date.now() - start > LOCK_TIMEOUT) {
      throw new Error(`Timeout waiting for file lock: ${file}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_INTERVAL); // Native sleep (Node >= 9.3)
  }
  try {
    fs.writeFileSync(lock, process.pid.toString(), { flag: 'wx' }); // Exclusive create
    return () => { if (fs.existsSync(lock)) fs.unlinkSync(lock); }; // unlock function
  } catch (e) {
    throw new Error(`Unable to acquire file lock: ${file}`);
  }
}

// -------------
// Utilities
// -------------
function loadEncryptedStorage(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  let unlock;
  try {
    unlock = lockFile(file);
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw) return fallback;
    return decryptData(raw) || fallback;
  } catch (e) {
    return fallback;
  } finally {
    if (unlock) unlock();
  }
}

function saveEncryptedStorage(file, data) {
  let unlock;
  try {
    unlock = lockFile(file);
    fs.writeFileSync(file, encryptData(data), 'utf8');
  } finally {
    if (unlock) unlock();
  }
}

// Removes expired sessions/cookies
function cleanupSessions(sessions) {
  const now = Date.now();
  let changed = false;
  for (const sid of Object.keys(sessions)) {
    if (!sessions[sid] || (sessions[sid].createdAt && now - sessions[sid].createdAt > SESSION_LIFETIME)) {
      delete sessions[sid];
      changed = true;
    }
  }
  return changed;
}
function cleanupCookies(cookies, validSessionIds = []) {
  let changed = false;
  for (const sid of Object.keys(cookies)) {
    if (!validSessionIds.includes(sid)) {
      delete cookies[sid];
      changed = true;
    }
  }
  return changed;
}

// --------
// Sessions
// --------
function generateSessionId() {
  return crypto.randomBytes(24).toString('hex');
}

function createSession(userId) {
  let sessions = loadEncryptedStorage(SESSIONS_FILE, {});
  const now = Date.now();
  const sessionId = generateSessionId();
  sessions[sessionId] = {
    userId,
    sessionId,
    createdAt: now,
    lastActive: now,
    data: {},
  };
  // Clean up old sessions on each creation
  cleanupSessions(sessions);
  saveEncryptedStorage(SESSIONS_FILE, sessions);
  return sessionId;
}

function getSession(sessionId) {
  let sessions = loadEncryptedStorage(SESSIONS_FILE, {});
  // Clean and persist if needed
  if (cleanupSessions(sessions)) {
    saveEncryptedStorage(SESSIONS_FILE, sessions);
  }
  const session = sessions[sessionId];
  const now = Date.now();
  if (session && now - (session.createdAt || 0) <= SESSION_LIFETIME) {
    session.lastActive = now;
    sessions[sessionId] = session;
    saveEncryptedStorage(SESSIONS_FILE, sessions);
    return { ...session }; // Return a copy
  }
  // Not found or expired
  if (sessionId && sessions[sessionId]) {
    delete sessions[sessionId];
    saveEncryptedStorage(SESSIONS_FILE, sessions);
  }
  return null;
}

function persistSession(sessionData) {
  if (!sessionData || !sessionData.sessionId) return false;
  let sessions = loadEncryptedStorage(SESSIONS_FILE, {});
  // Clean up old sessions
  cleanupSessions(sessions);
  sessions[sessionData.sessionId] = {
    ...sessionData,
    lastActive: Date.now(),
  };
  saveEncryptedStorage(SESSIONS_FILE, sessions);
  return true;
}

// --------
// Cookies
// --------
function restoreCookies(sessionId) {
  const cookies = loadEncryptedStorage(COOKIES_FILE, {});
  // No expiration for cookies, but cross-clean with sessions
  return (cookies[sessionId] && Array.isArray(cookies[sessionId])) ? [...cookies[sessionId]] : [];
}

function persistCookies(sessionId, cookiesArray) {
  let cookies = loadEncryptedStorage(COOKIES_FILE, {});
  cookies[sessionId] = Array.isArray(cookiesArray)
    ? cookiesArray.slice()
    : [];
  // Clean cookies for expired sessions etc.
  const sessions = loadEncryptedStorage(SESSIONS_FILE, {});
  if (cleanupCookies(cookies, Object.keys(sessions))) {
    saveEncryptedStorage(COOKIES_FILE, cookies);
  }
  saveEncryptedStorage(COOKIES_FILE, cookies);
  return true;
}

// -----------
// Session End
// -----------
function endSession(sessionId) {
  let sessions = loadEncryptedStorage(SESSIONS_FILE, {});
  let cookies = loadEncryptedStorage(COOKIES_FILE, {});
  if (sessions[sessionId]) delete sessions[sessionId];
  if (cookies[sessionId]) delete cookies[sessionId];
  // periodic cleanup
  cleanupSessions(sessions);
  cleanupCookies(cookies, Object.keys(sessions));
  saveEncryptedStorage(SESSIONS_FILE, sessions);
  saveEncryptedStorage(COOKIES_FILE, cookies);
  return true;
}

// ---------------
// Background task
// ---------------
// (Optional suggestion: Call this in a periodic interval in your app.)
function cleanupAll() {
  let sessions = loadEncryptedStorage(SESSIONS_FILE, {});
  let cookies = loadEncryptedStorage(COOKIES_FILE, {});
  const changedSessions = cleanupSessions(sessions);
  const changedCookies = cleanupCookies(cookies, Object.keys(sessions));
  if (changedSessions) saveEncryptedStorage(SESSIONS_FILE, sessions);
  if (changedCookies) saveEncryptedStorage(COOKIES_FILE, cookies);
}

module.exports = {
  createSession,
  getSession,
  restoreCookies,
  persistSession,
  persistCookies,
  endSession,
  cleanupAll, // for optional scheduled cleanup
};