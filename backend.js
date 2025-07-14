const express = require('express');
const session = require('express-session');
const http = require('http');
const WebSocket = require('ws');
const { google } = require('googleapis');
const axios = require('axios');
const winston = require('winston');
const i18next = require('i18next');
const Backend = require('i18next-fs-backend');
const csv = require('csv-parser');
const fs = require('fs');
const ini = require('ini');
const xml2js = require('xml2js');
const path = require('path');
const Redis = require('ioredis');
const RedisStore = require('connect-redis')(session);
const jwt = require('jsonwebtoken'); // Added for JWT logic from auth.js

// ---- Configs ----
const config = ini.parse(fs.readFileSync('./config.ini', 'utf-8'));
const GOOGLE_CLIENT_ID = config.oauth.google_client_id;
const GOOGLE_CLIENT_SECRET = config.oauth.google_client_secret;
const GOOGLE_REDIRECT_URI = config.oauth.google_redirect_uri;
const SESSION_SECRET = config.session.secret;
const ANALYTICS_LOG_FILE = config.analytics.log_file;
const CLOUD_STORAGE_API = config.cloud.api_endpoint;
const PORT = config.server.port;
// Check for critical secrets and config
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI || !SESSION_SECRET) {
    throw new Error('Missing required configuration. Please check config.ini for secrets and API endpoints.');
}
if (!ANALYTICS_LOG_FILE) {
    throw new Error('Missing analytics log file path in configuration.');
}

const gettextParser = require('gettext-parser'); // For Translator

// ---- Utility Classes from node.js ----
class ConfigLoader {
    constructor() {
        this.config = {};
    }

    loadINI(filePath) {
        const data = fs.readFileSync(filePath, 'utf-8');
        this.config = ini.parse(data);
        return this.config;
    }

    async loadXML(filePath) { // Note: xml2js is already required at the top
        const data = fs.readFileSync(filePath, 'utf-8');
        return new Promise((resolve, reject) => {
            xml2js.parseString(data, (err, result) => {
                if (err) return reject(err);
                this.config = { ...this.config, ...result }; // Merges with existing if any
                resolve(this.config);
            });
        });
    }
}

class Translator {
    constructor(potFile) {
        this.potFile = potFile;
        this.translations = this.loadPotProper(potFile);
    }

    loadPotProper(filePath) {
        if (!fs.existsSync(filePath)) return {};
        const raw = fs.readFileSync(filePath);
        let catalog;
        try {
            catalog = gettextParser.po.parse(raw);
        } catch (e) {
            // console.error("Failed to parse POT file:", e);
            return {};
        }
        const result = {};
        if (catalog && catalog.translations) {
            for (const ctx in catalog.translations) {
                if (catalog.translations[ctx]) { // Check if context exists
                    for (const key in catalog.translations[ctx]) {
                        const trans = catalog.translations[ctx][key];
                        if (trans && trans.msgid && trans.msgstr && trans.msgstr.length && trans.msgstr[0]) {
                            result[trans.msgid] = trans.msgstr[0];
                        }
                    }
                }
            }
        }
        return result;
    }

    t(key, ...args) {
        let translated = this.translations[key] || key;
        if (args.length > 0) {
            // Basic string formatting (replace %s, %d, etc.)
            let i = 0;
            translated = translated.replace(/%[sdifjo%]/g, (match) => {
                if (match === '%%') return '%';
                if (i < args.length) return args[i++];
                return match;
            });
        }
        return translated;
    }
}

// ---- Logging (using Winston, already defined) ----
// const logger = winston.createLogger({ ... }); // This is defined below, no need to redefine
// We can enhance it or use a custom Logger class if Winston is not preferred.
// For now, Winston setup is kept.

// ---- Logging ----
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: ANALYTICS_LOG_FILE }),
        new winston.transports.Console()
    ]
});

// ---- i18n ----
i18next.use(Backend).init({
    lng: 'en',
    fallbackLng: 'en',
    backend: {
        loadPath: path.join(__dirname, 'locales/{{lng}}.pot')
    },
    interpolation: { escapeValue: false }
});

// ---- Redis Session Store ----
const redisClient = new Redis(config.session.redis_url || process.env.REDIS_URL); // Renamed to redisClient to avoid conflict if 'redis' module itself is used elsewhere
const sessionMiddleware = session({
    store: new RedisStore({ client: redisClient }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production', // Secure flag set automatically
        httpOnly: true,
        sameSite: 'lax'
    }
});

// ---- Express ----
const app = express();
const server = http.createServer(app);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);

// Session data is now handled by connect-redis and express-session
function getUserSession(userId, cb) {
    if (!userId) return cb(null, null);
    const sid = `sess:${userId}`; // This key format might be specific to how sessions were previously stored. connect-redis might use a different format.
                               // Typically, you'd retrieve the session via req.session in a request context.
                               // For non-request use, you'd need to know the session ID used by connect-redis.
    redisClient.get(sid, (err, data) => { // Use redisClient
        if (err) return cb(err, null);
        if (!data) return cb(null, null);
        try { cb(null, JSON.parse(data)); }
        catch (e) { cb(e, null); }
    });
}

function setUserSession(req, userId, sessionData) {
    req.session.userId = userId; // Storing userId in session
    Object.assign(req.session, sessionData);
    return new Promise((resolve, reject) => {
        req.session.save(err => err ? reject(err) : resolve());
    });
}

// ---- Analytics ----
function logAnalyticsEvent(eventData) {
    logger.info({ type: 'analytics_event', ...eventData });
}

// ---- Cloud Storage Sync ----
async function syncWithCloudStorage(data) {
    try {
        const res = await axios.post(CLOUD_STORAGE_API, data, {
            headers: { 'Authorization': `Bearer ${config.cloud.api_key}` }
        });
        return res.data;
    } catch (err) {
        logger.error({ type: 'cloud_sync_error', error: err.message });
        return null;
    }
}

// ---- Google Sheets Integration ----
async function processGoogleSheetsRequest(request) {
    const { accessToken, spreadsheetId, range, values, mode } = request;
    const perUserOAuth2 = new google.auth.OAuth2(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        GOOGLE_REDIRECT_URI
    );
    perUserOAuth2.setCredentials({ access_token: accessToken });
    const sheets = google.sheets({ version: 'v4', auth: perUserOAuth2 });

    if (mode === 'read') {
        const result = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range
        });
        return result.data;
    } else if (mode === 'write') {
        const result = await sheets.spreadsheets.values.update({
            spreadsheetId,
            range,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values }
        });
        return result.data;
    }
    throw new Error('Invalid Google Sheets request mode');
}

// ---- Generic OAuth Provider Config & JWT Settings (from auth.js) ----
const OAUTH_PROVIDERS = {}; // To be populated by initOAuthProviders
const JWT_SECRET = process.env.JWT_SECRET || config.session.jwt_secret; // Use config.ini or env
if (!JWT_SECRET) {
    // Fallback to a default if not set, though strongly discouraged for production
    logger.warn("JWT_SECRET not set in environment or config.ini, using a default. THIS IS INSECURE FOR PRODUCTION.");
    // In a real scenario, you might throw an error or have a more secure default generation for dev only
    // For this exercise, we'll use a fixed default if missing, but log a strong warning.
    // throw new Error('JWT_SECRET environment variable or config.ini session.jwt_secret must be set.');
}
const TOKEN_EXPIRY_SEC = config.session.jwt_token_expiry_sec || 3600; // 1 hour default

function initOAuthProviders(oauthConfig) {
    if (!oauthConfig) {
        logger.warn("No OAuth provider configuration provided to initOAuthProviders.");
        return;
    }
    Object.entries(oauthConfig).forEach(([providerName, values]) => {
        if (
            !values.client_id ||
            !values.client_secret ||
            !values.auth_url ||
            !values.token_url ||
            !values.user_info_url
        ) {
            logger.error(`Incomplete OAuth config for ${providerName}. Skipping.`);
            return;
        }
        OAUTH_PROVIDERS[providerName] = {
            clientId: values.client_id,
            clientSecret: values.client_secret,
            authUrl: values.auth_url,
            tokenUrl: values.token_url,
            userInfoUrl: values.user_info_url,
            redirectUri: values.redirect_uri // Assuming redirect_uri is part of the provider config in config.ini
        };
        logger.info(`Initialized OAuth provider: ${providerName}`);
    });
}

// Initialize OAuth providers from config.ini
// Assuming a structure like:
// [oauth_providers.google]
// client_id=...
// client_secret=...
// auth_url=https://accounts.google.com/o/oauth2/v2/auth
// token_url=https://oauth2.googleapis.com/token
// user_info_url=https://www.googleapis.com/oauth2/v3/userinfo
// redirect_uri=http://localhost:PORT/auth/google/callback (Ensure this matches your GOOGLE_REDIRECT_URI)
//
// [oauth_providers.another_provider]
// ...
if (config.oauth_providers) {
    initOAuthProviders(config.oauth_providers);
} else {
    // Setup Google specifically if generic provider config is missing, using existing constants
    OAUTH_PROVIDERS['google'] = {
        clientId: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', // Standard Google Auth URL
        tokenUrl: 'https://oauth2.googleapis.com/token', // Standard Google Token URL
        userInfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo', // Standard Google UserInfo URL
        redirectUri: GOOGLE_REDIRECT_URI
    };
     logger.info("Initialized Google OAuth provider using direct config values.");
}


// ---- Google OAuth flow (specific to Google, uses GOOGLE_CLIENT_ID etc.) ----
const GOOGLE_OAUTH_SCOPES = [ // Renamed to avoid conflict if generic OAUTH_SCOPES is used
    'profile', 'email',
    'https://www.googleapis.com/auth/spreadsheets'
];

app.get('/auth/google', (req, res) => {
    const oauth2Client = new google.auth.OAuth2(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        GOOGLE_REDIRECT_URI
    );
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: OAUTH_SCOPES
    });
    res.redirect(url);
});

async function handleOAuthCallback(req, res) {
    try {
        const { code } = req.query;
        const oauth2Client = new google.auth.OAuth2(
            GOOGLE_CLIENT_ID,
            GOOGLE_CLIENT_SECRET,
            GOOGLE_REDIRECT_URI
        );
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        const ticket = await oauth2Client.verifyIdToken({
            idToken: tokens.id_token,
            audience: GOOGLE_CLIENT_ID
        });
        const payload = ticket.getPayload();
        const userId = payload['sub']; // Google User ID

        // Fetch user profile
        const people = google.people({version: 'v1', auth: oauth2Client});
        const profileInfo = await people.people.get({
            resourceName: 'people/me',
            personFields: 'names,emailAddresses',
        });

        const primaryName = profileInfo.data.names && profileInfo.data.names.find(n => n.metadata.primary);
        const primaryEmail = profileInfo.data.emailAddresses && profileInfo.data.emailAddresses.find(e => e.metadata.primary);

        const userProfile = {
            id: userId,
            displayName: primaryName ? primaryName.displayName : 'N/A',
            email: primaryEmail ? primaryEmail.value : 'N/A',
            // Add other relevant profile fields from 'payload' or 'profileInfo'
        };

        await setUserSession(req, userId, {
            google_tokens: tokens, // Store Google tokens specifically
            user: userProfile,     // Store our standardized user profile
            loggedInAt: Date.now()
        });

        logAnalyticsEvent({
            userId,
            event: 'oauth_callback_success',
            timestamp: new Date().toISOString()
        });

        res.redirect('/dashboard'); // Or wherever your app directs after login
    } catch (error) {
        logger.error({ type: 'oauth_callback_error', error: error.message, stack: error.stack });
        res.status(500).send('OAuth callback failed. ' + error.message);
    }
}

app.get('/auth/google/callback', handleOAuthCallback);

// ---- Generic OAuth & JWT Functions (adapted from auth.js) ----

// Generic user info fetcher
async function fetchProviderUserInfo(providerName, accessToken) {
    const prov = OAUTH_PROVIDERS[providerName];
    if (!prov || !prov.userInfoUrl) {
        logger.error(`User info URL not configured for provider: ${providerName}`);
        throw new Error(`User info URL not configured for provider: ${providerName}`);
    }
    try {
        const response = await axios.get(prov.userInfoUrl, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        // Standardize: always return {id, email, provider, raw}
        let id, email;
        const d = response.data;
        if (d.sub) id = d.sub; // Standard OIDC claim
        else if (d.id) id = d.id; // Common alternative
        else {
            logger.error(`No user ID (sub or id) found in userInfo response for ${providerName}`, d);
            throw new Error('No user ID found in userInfo response');
        }
        if (typeof d.email === 'string') email = d.email;
        else email = null;

        return {
            id: String(id), // Ensure ID is a string
            email,
            provider: providerName,
            raw: d, // Raw provider response
            displayName: d.name || d.displayName || (d.given_name && d.family_name ? `${d.given_name} ${d.family_name}` : null),
        };
    } catch (error) {
        logger.error(`Failed to fetch user info from ${providerName}`, { error: error.message, status: error.response?.status });
        throw error;
    }
}


// This function is more specific to Google and session based,
// The generic fetchProviderUserInfo can be used by a more generic login handler.
// For now, keeping authenticateUserFromSession as it was, but it could be refactored
// to use fetchProviderUserInfo if we make the login flow more generic.
async function authenticateUserFromSession(session) {
    if (!session || !session.google_tokens) {
        throw new Error('No Google tokens in session for authentication.');
    }
    const oauth2Client = new google.auth.OAuth2(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        GOOGLE_REDIRECT_URI
    );
    oauth2Client.setCredentials(session.google_tokens);

    try {
        // Optionally refresh token if about to expire - googleapis library handles this for some APIs
        // For userinfo, typically not needed unless token is fully expired
        const people = google.people({version: 'v1', auth: oauth2Client});
        const profileInfo = await people.people.get({
            resourceName: 'people/me',
            personFields: 'names,emailAddresses',
        });

        const primaryName = profileInfo.data.names && profileInfo.data.names.find(n => n.metadata.primary);
        const primaryEmail = profileInfo.data.emailAddresses && profileInfo.data.emailAddresses.find(e => e.metadata.primary);

        return {
            id: session.userId, // or from profileInfo if preferred
            displayName: primaryName ? primaryName.displayName : 'N/A',
            email: primaryEmail ? primaryEmail.value : 'N/A',
        };
    } catch (error) {
        logger.error({ type: 'authenticate_user_error', userId: session.userId, error: error.message });
        // Check if token expired or was revoked
        if (error.response && (error.response.status === 400 || error.response.status === 401)) {
            // Attempt to refresh token if a refresh token is available
            if (session.google_tokens.refresh_token) {
                try {
                    const { tokens: newTokens } = await oauth2Client.refreshToken(session.google_tokens.refresh_token);
                    // Update session with new tokens
                    session.google_tokens = { ...session.google_tokens, ...newTokens };
                    // TODO: Need a way to persist this updated session back to Redis if req object is not available here.
                    // This function might need `req` as a parameter to save the session.
                    logger.info({ type: 'token_refreshed', userId: session.userId });
                    // Retry fetching user info with new token
                    oauth2Client.setCredentials(newTokens);
                    const refreshedProfileInfo = await people.people.get({
                        resourceName: 'people/me',
                        personFields: 'names,emailAddresses',
                    });
                    const refreshedPrimaryName = refreshedProfileInfo.data.names && refreshedProfileInfo.data.names.find(n => n.metadata.primary);
                    const refreshedPrimaryEmail = refreshedProfileInfo.data.emailAddresses && refreshedProfileInfo.data.emailAddresses.find(e => e.metadata.primary);
                    return {
                        id: session.userId,
                        displayName: refreshedPrimaryName ? refreshedPrimaryName.displayName : 'N/A',
                        email: refreshedPrimaryEmail ? refreshedPrimaryEmail.value : 'N/A',
                    };

                } catch (refreshError) {
                    logger.error({ type: 'token_refresh_failed', userId: session.userId, error: refreshError.message });
                    throw new Error('Failed to refresh token and authenticate user.');
                }
            }
        }
        throw error; // Re-throw original error if not a token issue or no refresh token
    }
}

// Generic login handler (can be adapted for different providers)
// This is a more generalized version of the Google-specific callback.
// For now, the Google-specific one is still active. This is for future use or refactoring.
async function handleGenericOAuthLogin(req, providerName, code, redirectUri) {
    const prov = OAUTH_PROVIDERS[providerName];
    if (!prov) {
        logger.error(`Login attempt with unknown provider: ${providerName}`);
        throw new Error(`Unknown OAuth provider: ${providerName}`);
    }

    try {
        const tokenResponse = await axios.post(
            prov.tokenUrl,
            new URLSearchParams({
                code,
                client_id: prov.clientId,
                client_secret: prov.clientSecret,
                grant_type: 'authorization_code',
                redirect_uri: redirectUri || prov.redirectUri, // Use provider's default redirect URI if not specified
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const { access_token, refresh_token, expires_in, id_token } = tokenResponse.data;

        // Fetch user info using the generic fetcher
        const userInfo = await fetchProviderUserInfo(providerName, access_token);

        const userId = userInfo.id;

        // Store tokens and user profile in session (using express-session)
        await setUserSession(req, userId, {
            [`${providerName}_tokens`]: { access_token, refresh_token, expires_in, id_token },
            user: { // Standardized user object
                id: userId,
                email: userInfo.email,
                displayName: userInfo.displayName,
                provider: providerName,
                providerProfile: userInfo.raw, // Keep raw provider profile if needed
            },
            loggedInAt: Date.now(),
            activeProvider: providerName
        });

        logger.info(`User ${userId} logged in via ${providerName}`);
        return { user: req.session.user, tokens: req.session[`${providerName}_tokens`] };

    } catch (error) {
        logger.error(`OAuth login failed for provider ${providerName}`, { error: error.message, stack: error.stack, response: error.response?.data });
        throw error; // Re-throw to be handled by the route
    }
}

async function handleGenericTokenRefresh(req, providerName) {
    const prov = OAUTH_PROVIDERS[providerName];
    if (!prov) throw new Error(`Unknown OAuth provider for token refresh: ${providerName}`);

    const sessionProviderTokens = req.session[`${providerName}_tokens`];
    if (!sessionProviderTokens || !sessionProviderTokens.refresh_token) {
        throw new Error(`No refresh token found in session for provider ${providerName}`);
    }

    try {
        const response = await axios.post(
            prov.tokenUrl,
            new URLSearchParams({
                refresh_token: sessionProviderTokens.refresh_token,
                client_id: prov.clientId,
                client_secret: prov.clientSecret,
                grant_type: 'refresh_token',
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        const { access_token, refresh_token: new_refresh_token, expires_in } = response.data;

        // Update session with new tokens
        req.session[`${providerName}_tokens`].access_token = access_token;
        if (new_refresh_token) { // Some providers might not return a new refresh token
            req.session[`${providerName}_tokens`].refresh_token = new_refresh_token;
        }
        req.session[`${providerName}_tokens`].expires_in = expires_in;
        // Update lastActive or similar timestamp if necessary
        req.session.refreshedAt = Date.now();
        await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));

        logger.info(`Tokens refreshed for user ${req.session.userId} via ${providerName}`);
        return { access_token, refresh_token: req.session[`${providerName}_tokens`].refresh_token, expires_in };

    } catch (error) {
        logger.error(`Token refresh failed for ${providerName}`, { userId: req.session.userId, error: error.message, stack: error.stack });
        // If refresh fails (e.g. token revoked), clear the tokens from session and force re-login
        delete req.session[`${providerName}_tokens`];
        // Potentially clear other provider-specific session data
        await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
        throw new Error('Token refresh failed, please log in again.');
    }
}

function handleLogout(req) {
    return new Promise((resolve, reject) => {
        const userId = req.session.userId;
        req.session.destroy(err => {
            if (err) {
                logger.error('Session destruction failed during logout', { userId, error: err.message });
                return reject(err);
            }
            logger.info(`User ${userId} logged out.`);
            resolve();
        });
    });
}

// JWT specific functions (can be used for stateless API auth if needed)
function generateUserJWT(userId, provider) {
    if (!JWT_SECRET) {
        logger.error("JWT_SECRET is not configured. Cannot generate JWT.");
        return null;
    }
    return jwt.sign(
        { userId, provider, type: 'session' }, // Added type for clarity
        JWT_SECRET,
        { expiresIn: TOKEN_EXPIRY_SEC }
    );
}

function validateUserJWT(token) {
    if (!JWT_SECRET) {
        logger.error("JWT_SECRET is not configured. Cannot validate JWT.");
        return null;
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        // Additional checks can be added here, e.g., if the user session is still valid in Redis
        return { userId: decoded.userId, provider: decoded.provider };
    } catch (err) {
        logger.warn('JWT validation failed', { token, error: err.message });
        return null;
    }
}

// Example of a JWT protected middleware (not used by default routes yet)
function ensureAuthenticatedJWT(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7, authHeader.length);
        const userData = validateUserJWT(token);
        if (userData) {
            req.user = userData; // Attach user data to request
            return next();
        }
    }
    res.status(401).json({ error: 'Unauthorized: Invalid or missing JWT token.' });
}

// Standard express-session based authentication check middleware
function ensureAuthenticatedSession(req, res, next) {
    if (req.session && req.session.userId) {
        return next();
    }
    res.status(401).json({ error: 'Unauthorized: Please login.' });
}


// ---- WebSockets ----
const wss = new WebSocket.Server({ server, path: '/ws' });

// Modified to correctly use express-session with WebSockets
wss.on('connection', (socket, req) => {
    // `req` is the upgrade request. We need to run session middleware on it.
    sessionMiddleware(req, {}, () => {
        if (req.session) {
            socket.session = req.session; // Attach session to the WebSocket object
            logger.info({ type: 'ws_connection_established_with_session', sessionId: req.session.id, userId: req.session.userId });
        } else {
            logger.warn({ type: 'ws_connection_established_without_session' });
        }
        handleWebSocketConnection(socket, req); // Pass req if needed by handler
    });
});


function handleWebSocketConnection(socket, req) { // req is passed here
    socket.on('message', async (msg) => {
        try {
            const data = JSON.parse(msg);
            // Access session from socket.session if attached
            const currentSession = socket.session;

            if (!currentSession || !currentSession.google_tokens) {
                socket.send(JSON.stringify({ error: 'Unauthorized: No session or tokens for WS action.' }));
                return;
            }

            if (data.type === 'google_sheets') {
                 if (!currentSession.google_tokens.access_token) {
                    socket.send(JSON.stringify({ error: 'Missing access token for Google Sheets' }));
                    return;
                }
                data.payload.accessToken = currentSession.google_tokens.access_token; // Use token from session
                const resp = await processGoogleSheetsRequest(data.payload);
                socket.send(JSON.stringify({ type: 'google_sheets_response', data: resp }));
            } else if (data.type === 'cloud_sync') {
                const resp = await syncWithCloudStorage(data.payload); // Assuming cloud_sync doesn't need user-specific token from session
                socket.send(JSON.stringify({ type: 'cloud_sync_response', data: resp }));
            } else if (data.type === 'track_event') {
                const eventPayload = { ...(data.payload || {}), userId: currentSession.userId };
                logAnalyticsEvent(eventPayload);
            } else {
                socket.send(JSON.stringify({ error: 'Unknown WS message type' }));
            }
        } catch (err) {
            logger.error({ type: 'ws_message_error', error: err.message, stack: err.stack });
            socket.send(JSON.stringify({ error: 'Invalid request: ' + err.message }));
        }
    });
    socket.on('close', () => {
        logger.info({ type: 'ws_connection_closed', sessionId: socket.session ? socket.session.id : 'N/A', timestamp: new Date().toISOString() });
    });
     socket.on('error', (error) => {
        logger.error({ type: 'ws_socket_error', sessionId: socket.session ? socket.session.id : 'N/A', error: error.message, stack: error.stack });
    });
}

// ---- Misc Sample Endpoint ----
app.post('/api/formdata', async (req, res) => {
    if (!req.session || !req.session.userId) { // Check session and userId
        return res.status(401).send('Unauthorized: Please login.');
    }
    try {
        const syncResult = await syncWithCloudStorage(req.body);
        logAnalyticsEvent({
            userId: req.session.userId,
            event: 'form_submit',
            timestamp: new Date().toISOString(),
            details: syncResult
        });
        res.json({ success: true, cloudResult: syncResult });
    } catch (err) {
        logger.error({ type: 'formdata_api_error', error: err.message, stack: err.stack });
        res.status(500).send('Internal error processing form data.');
    }
});

// ---- Read XML, CSV Sample Files if Needed ----
// These seem like general utilities, could be moved if backend.js gets too large
function loadCsv(filePath) {
    return new Promise((resolve, reject) => {
        const results = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', data => results.push(data))
            .on('end', () => resolve(results))
            .on('error', reject);
    });
}

function loadXml(filePath) {
    return new Promise((resolve, reject) => {
        fs.readFile(filePath, (err, data) => {
            if (err) return reject(err);
            xml2js.parseString(data, (err, result) => {
                if (err) return reject(err);
                resolve(result);
            });
        });
    });
}

// ---- Server Startup ----
function startServer() {
    server.listen(PORT, () => {
        logger.info({ type: 'server_start', port: PORT, timestamp: new Date().toISOString() });
    });
}

// Automatically start the server when this file is run
startServer();

// Export relevant functions if this were to be required as a module elsewhere,
// but since it's the main backend file, direct execution is primary.
module.exports = {
    app, // Export app for potential testing or advanced scenarios
    server, // Export server for more direct control if needed
    startServer, // To allow programmatic start if not run directly
    // Potentially other functions if they need to be accessed by other backend modules
    // For now, most functions are internal to backend.js
};
