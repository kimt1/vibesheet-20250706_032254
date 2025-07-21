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
const redis = new Redis(config.session.redis_url || process.env.REDIS_URL);
const sessionMiddleware = session({
    store: new RedisStore({ client: redis }),
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

// ---- Sessions (persistent via Redis, in-memory fallback removed) ----
// Session data is now handled by connect-redis and express-session
function getUserSession(userId, cb) {
    // express-session handles in request context, userId optional
    // For non-request use: retrieve from Redis
    if (!userId) return cb(null, null);
    const sid = `sess:${userId}`;
    redis.get(sid, (err, data) => {
        if (err) return cb(err, null);
        if (!data) return cb(null, null);
        try { cb(null, JSON.parse(data)); }
        catch (e) { cb(e, null); }
    });
}

function setUserSession(req, userId, sessionData) {
    // express-session auto savings handled. Just attach to req.session
    req.session.userId = userId;
    Object.assign(req.session, sessionData);
    // Save explicitly to ensure persistence before continuing
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
    // Per-request OAuth2 client, never use shared instance to avoid concurrency bugs
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

// ---- OAuth flow ----
const OAUTH_SCOPES = [
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
        // Use per-request OAuth2 client to avoid token cross-leakage
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
        const userId = payload['sub'];

        const user = await authenticateUser(tokens);

        // Store tokens and user profile in session
        await setUserSession(req, userId, {
            tokens,
            user,
            created: Date.now()
        });

        logAnalyticsEvent({
            userId,
            event: 'oauth_callback',
            timestamp: new Date().toISOString()
        });

        res.redirect('/dashboard');
    } catch (error) {
        logger.error({ type: 'oauth_callback_error', error: error.message });
        res.status(500).send('OAuth callback failed');
    }
}

app.get('/auth/google/callback', handleOAuthCallback);

async function authenticateUser(token) {
    // Always use per-request OAuth2 client
    const oauth2Client = new google.auth.OAuth2(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        GOOGLE_REDIRECT_URI
    );
    oauth2Client.setCredentials(token);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const res = await oauth2.userinfo.get();
    return res.data;
}

// ---- WebSockets ----
const wss = new WebSocket.Server({ server, path: '/ws' });

// Shared session for WS handshake
function wrapExpressSessionMiddleware(middleware) {
    return (ws, req, next) => {
        middleware(req, {}, next);
    };
}

wss.on('connection', function(socket, req) {
    // Attach the session data from the HTTP upgrade request (if possible)
    if (req && req.session) socket.session = req.session;
    handleWebSocketConnection(socket, req);
});

function handleWebSocketConnection(socket, req) {
    socket.on('message', async (msg) => {
        try {
            const data = JSON.parse(msg);
            // Per-message token logic: never share clients between users
            if (data.type === 'google_sheets') {
                const resp = await processGoogleSheetsRequest(data.payload);
                socket.send(JSON.stringify({ type: 'google_sheets_response', data: resp }));
            } else if (data.type === 'cloud_sync') {
                const resp = await syncWithCloudStorage(data.payload);
                socket.send(JSON.stringify({ type: 'cloud_sync_response', data: resp }));
            } else if (data.type === 'track_event') {
                logAnalyticsEvent(data.payload);
            }
        } catch (err) {
            logger.error({ type: 'ws_message_error', error: err.message });
            socket.send(JSON.stringify({ error: 'Invalid request' }));
        }
    });
    socket.on('close', () => {
        logger.info({ type: 'ws_connection_closed', timestamp: new Date().toISOString() });
    });
}

// ---- Misc Sample Endpoint ----
app.post('/api/formdata', async (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.status(401).send('Unauthorized');
    const sessionData = req.session;
    if (!sessionData) return res.status(401).send('Session expired');

    try {
        // Example: Sync submitted form data with cloud storage
        const syncResult = await syncWithCloudStorage(req.body);
        logAnalyticsEvent({
            userId,
            event: 'form_submit',
            timestamp: new Date().toISOString(),
            details: syncResult
        });
        res.json({ success: true, cloudResult: syncResult });
    } catch (err) {
        logger.error({ type: 'formdata_error', error: err.message });
        res.status(500).send('Internal error');
    }
});

// ---- Read XML, CSV Sample Files if Needed ----
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

// Start server only when executed directly
if (require.main === module) {
    startServer();
}

module.exports = {
    startServer,
    handleOAuthCallback,
    authenticateUser,
    getUserSession,
    logAnalyticsEvent,
    handleWebSocketConnection,
    syncWithCloudStorage,
    processGoogleSheetsRequest
};