const crypto = require('crypto');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const OAUTH_PROVIDERS = {};
// In production, replace this with a persistent/distributed store like Redis or a database
const SESSIONS = new Map();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    'JWT_SECRET environment variable must be set. Do NOT auto-generate a default secret.'
  );
}
const TOKEN_EXPIRY_SEC = 3600; // 1 hour

/**
 * Initialize supported OAuth providers configuration.
 *
 * @param {Object} config
 *  {
 *    providerName: {
 *      clientId, clientSecret, authUrl, tokenUrl, userInfoUrl
 *    },
 *    ...
 *  }
 */
function initOAuthProviders(config) {
  Object.entries(config).forEach(([provider, values]) => {
    if (
      !values.clientId ||
      !values.clientSecret ||
      !values.authUrl ||
      !values.tokenUrl ||
      !values.userInfoUrl
    ) {
      throw new Error(`Incomplete OAuth config for ${provider}`);
    }
    OAUTH_PROVIDERS[provider] = { ...values };
  });
}

/**
 * Handle login via OAuth provider: exchange code, fetch user info, create session/jwt.
 *
 * @param {string} provider
 * @param {Object} params { code, redirectUri }
 * @returns {Promise<Object>}
 */
async function loginWithProvider(provider, { code, redirectUri }) {
  const prov = OAUTH_PROVIDERS[provider];
  if (!prov) throw new Error(`Unknown OAuth provider: ${provider}`);

  const response = await axios.post(
    prov.tokenUrl,
    new URLSearchParams({
      code,
      client_id: prov.clientId,
      client_secret: prov.clientSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const { access_token, refresh_token, expires_in, id_token } = response.data;

  const userInfo = await getUserInfo(provider, access_token);

  // Standardize the userInfo object to always have id, email (can be null), raw, provider
  const userSession = {
    id: userInfo.id,
    email: userInfo.email || null,
    provider,
    raw: userInfo.raw,
  };

  const sessionToken = jwt.sign(
    {
      userId: userSession.id,
      provider,
      exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_SEC,
    },
    JWT_SECRET
  );

  SESSIONS.set(userSession.id, {
    accessToken: access_token,
    refreshToken: refresh_token,
    provider,
    expiresAt: Date.now() + expires_in * 1000,
    sessionToken,
    userInfo: userSession,
  });

  return {
    user: userSession,
    sessionToken,
    expiresIn: TOKEN_EXPIRY_SEC,
    refreshToken: refresh_token,
    provider,
  };
}

/**
 * Fetch and standardize user info from OAuth provider.
 *
 * @param {string} provider
 * @param {string} accessToken
 * @returns {Promise<{id: string, email: string|null, provider: string, raw: Object}>}
 */
async function getUserInfo(provider, accessToken) {
  const prov = OAUTH_PROVIDERS[provider];
  if (!prov.userInfoUrl) throw new Error('OAuth provider missing userInfoUrl');
  const response = await axios.get(prov.userInfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // Standardize: always return {id, email, provider, raw}
  let id, email;
  const d = response.data;
  if (d.sub) id = d.sub;
  else if (d.id) id = d.id;
  else throw new Error('No user ID found in userInfo response');
  if (typeof d.email === 'string') email = d.email;
  else email = null;

  // Add further normalization if provider is known to use other field names (future proof)
  return {
    id,
    email,
    provider,
    raw: d,
  };
}

/**
 * Refresh OAuth tokens, and update session in the session store.
 *
 * @param {string} refreshToken
 * @param {string} providerName
 * @returns {Promise<Object>}
 */
async function handleTokenRefresh(refreshToken, providerName) {
  const prov = OAUTH_PROVIDERS[providerName];
  if (!prov) throw new Error(`Unknown OAuth provider: ${providerName}`);

  const response = await axios.post(
    prov.tokenUrl,
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: prov.clientId,
      client_secret: prov.clientSecret,
      grant_type: 'refresh_token',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const { access_token, refresh_token: new_refresh_token, expires_in } = response.data;

  // Find session by refresh token (inefficient for Map; in real persistent store, index on refreshToken or userId)
  let sessionUserId = null;
  for (const [uid, session] of SESSIONS.entries()) {
    if (session.refreshToken === refreshToken) {
      sessionUserId = uid;
      break;
    }
  }
  // If found, update session with new tokens/times
  if (sessionUserId) {
    const session = SESSIONS.get(sessionUserId);
    // Optionally, regenerate sessionToken with new expiry
    const newSessionToken = jwt.sign(
      {
        userId: session.userInfo.id,
        provider: session.provider,
        exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_SEC,
      },
      JWT_SECRET
    );
    session.accessToken = access_token;
    session.refreshToken = new_refresh_token || refreshToken;
    session.expiresAt = Date.now() + expires_in * 1000;
    session.sessionToken = newSessionToken;
    SESSIONS.set(sessionUserId, session);
  }

  return {
    accessToken: access_token,
    refreshToken: new_refresh_token || refreshToken,
    expiresIn: expires_in,
  };
}

/**
 * Log out and clear user session.
 * @param {string} userId
 */
function logoutUser(userId) {
  SESSIONS.delete(userId);
}

/**
 * Verify and validate a provided session JWT token.
 *
 * @param {string} token
 * @returns {null|{userId: string, provider: string}}
 */
function validateSessionToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const session = SESSIONS.get(decoded.userId);
    if (!session || session.sessionToken !== token) return null;
    if (Date.now() > session.expiresAt) {
      SESSIONS.delete(decoded.userId);
      return null;
    }
    return { userId: decoded.userId, provider: decoded.provider };
  } catch (err) {
    return null;
  }
}

module.exports = {
  initOAuthProviders,
  loginWithProvider,
  handleTokenRefresh,
  logoutUser,
  validateSessionToken,
};