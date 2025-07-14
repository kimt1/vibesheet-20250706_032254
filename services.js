// Contents from analytics.js

// Requires:
// const fs = require('fs');
// const path = require('path');
// const { parseAsync } = require('json2csv');

// Top-level requires for services.js
const fs = require('fs');
const path = require('path');
const { parseAsync } = require('json2csv'); // For analytics CSV export
const { google } = require('googleapis');    // For GoogleSheetsConnector
const EventEmitter = require('events');      // For GoogleSheetsConnector & NotificationManager
const { v4: uuidv4 } = require('uuid');      // For NotificationManager


// Paths - these might need to be configurable or passed in if services.js is generic
const ANALYTICS_LOG_FILE_PATH = path.resolve(__dirname, 'analytics.log'); // Renamed
const ERROR_LOG_FILE_PATH = path.resolve(__dirname, 'analytics_error.log'); // Renamed
const STATS_DB_FILE_PATH = path.resolve(__dirname, 'analytics_stats.json');  // Renamed

// --- Input Validation/Sanitization Helpers (from analytics.js) ---

function analyticsIsValidString(val, maxLength = 128) { // Renamed
    return typeof val === 'string' && val.length > 0 && val.length <= maxLength && !/[<>]/.test(val);
}
function analyticsSanitizeString(val, maxLength = 512) { // Renamed
    if (typeof val !== 'string') return '';
    return val.replace(/[<>]/g, '').substring(0, maxLength);
}
function analyticsCleanEventData(eventData) { // Renamed
    if (typeof eventData !== 'object' || eventData === null) return {};
    const cleaned = {};
    if (analyticsIsValidString(eventData.formId)) cleaned.formId = analyticsSanitizeString(eventData.formId, 128);
    if (analyticsIsValidString(eventData.userId || '')) cleaned.userId = analyticsSanitizeString(eventData.userId, 128);
    if (eventData.fields && typeof eventData.fields === 'object') {
        cleaned.fields = {};
        for (const k of Object.keys(eventData.fields)) {
            if (analyticsIsValidString(k, 64)) cleaned.fields[analyticsSanitizeString(k, 64)] = analyticsSanitizeString(eventData.fields[k], 256);
        }
    }
    if (eventData.success !== undefined) cleaned.success = !!eventData.success;
    if (eventData.errorCode && analyticsIsValidString(eventData.errorCode, 32))
        cleaned.errorCode = analyticsSanitizeString(eventData.errorCode, 32);
    if (eventData.errorMessage && analyticsIsValidString(eventData.errorMessage, 512))
        cleaned.errorMessage = analyticsSanitizeString(eventData.errorMessage, 512);
    if (eventData.timestamp) cleaned.timestamp = new Date(eventData.timestamp).toISOString();
    if (eventData.meta && typeof eventData.meta === 'object') cleaned.meta = eventData.meta;
    return cleaned;
}
function analyticsCleanInteractionData(data) { // Renamed
    const cleaned = {};
    if (data.field && analyticsIsValidString(data.field, 64))
        cleaned.field = analyticsSanitizeString(data.field, 64);
    if (data.value && analyticsIsValidString(data.value, 256))
        cleaned.value = analyticsSanitizeString(data.value, 256);
    if (analyticsIsValidString(data.userId || ''))
        cleaned.userId = analyticsSanitizeString(data.userId, 128);
    if (data.meta && typeof data.meta === 'object')
        cleaned.meta = data.meta;
    return cleaned;
}
function analyticsValidateFormId(formId) { // Renamed
    return analyticsIsValidString(formId) ? analyticsSanitizeString(formId, 128) : null;
}

// --- Async File Operations with Error Logging (from analytics.js) ---

async function analyticsLogToFile(filepath, data) { // Renamed
    try {
        const line = JSON.stringify({ ...data, timestamp: new Date().toISOString() }) + '\n';
        await fs.promises.appendFile(filepath, line, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
        try {
            const errData = { logError: err.message || String(err), originalData: (data && data.type) ? data.type : undefined, filepath, timestamp: new Date().toISOString() };
            await fs.promises.appendFile(ERROR_LOG_FILE_PATH, JSON.stringify(errData) + '\n', { encoding: 'utf8', mode: 0o600 });
        } catch {
            // Silently ignore
        }
    }
}

async function analyticsReadAllLines(filepath) { // Renamed
    try {
        if (!fs.existsSync(filepath)) return [];
        const content = await fs.promises.readFile(filepath, 'utf8');
        return content
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(line => {
                try {
                    return JSON.parse(line);
                } catch (e) {
                    analyticsLogToFile(ERROR_LOG_FILE_PATH, { type: 'parseError', error: e.message, raw: line });
                    return null;
                }
            })
            .filter(Boolean);
    } catch (e) {
        await analyticsLogToFile(ERROR_LOG_FILE_PATH, { type: 'readError', error: e.message, filepath });
        return [];
    }
}

let analyticsStatsDbWriteLock = Promise.resolve(); // Renamed

async function analyticsAggregateStatUpdate(eventType, formId) { // Renamed
    formId = analyticsValidateFormId(formId);
    if (!formId) return;
    await (analyticsStatsDbWriteLock = analyticsStatsDbWriteLock.then(async () => {
        let stats = {};
        try {
            if (fs.existsSync(STATS_DB_FILE_PATH)) {
                const raw = await fs.promises.readFile(STATS_DB_FILE_PATH, 'utf8');
                stats = JSON.parse(raw);
            }
        } catch (e) {
            stats = {};
            await analyticsLogToFile(ERROR_LOG_FILE_PATH, { type: 'statsReadError', error: e.message });
        }
        stats[formId] = stats[formId] || { submission: 0, interaction: 0, lastEvent: null };
        if (!['submission', 'interaction'].includes(eventType)) return;
        stats[formId][eventType] = (stats[formId][eventType] || 0) + 1;
        stats[formId].lastEvent = new Date().toISOString();
        try {
            await fs.promises.writeFile(STATS_DB_FILE_PATH, JSON.stringify(stats, null, 2), 'utf8');
        } catch (e) {
            await analyticsLogToFile(ERROR_LOG_FILE_PATH, { type: 'statsWriteError', error: e.message });
        }
    }));
}

async function logSubmissionEvent(eventData) {
    const cleanedData = analyticsCleanEventData(eventData);
    if (!cleanedData.formId) {
        await analyticsLogToFile(ERROR_LOG_FILE_PATH, { type: 'invalidEvent', event: 'submission', eventData });
        return;
    }
    await analyticsLogToFile(ANALYTICS_LOG_FILE_PATH, { type: 'submission', ...cleanedData });
    await analyticsAggregateStatUpdate('submission', cleanedData.formId);
}

async function trackFormInteraction(formId, data = {}) {
    formId = analyticsValidateFormId(formId);
    if (!formId) {
        await analyticsLogToFile(ERROR_LOG_FILE_PATH, { type: 'invalidEvent', event: 'interaction', formId, data });
        return;
    }
    const cleanedData = analyticsCleanInteractionData(data);
    await analyticsLogToFile(ANALYTICS_LOG_FILE_PATH, { type: 'interaction', formId, ...cleanedData });
    await analyticsAggregateStatUpdate('interaction', cleanedData.formId);
}

async function aggregateStats(queryParams = {}) {
    let stats = {};
    try {
        if (fs.existsSync(STATS_DB_FILE_PATH)) {
            stats = JSON.parse(await fs.promises.readFile(STATS_DB_FILE_PATH, 'utf8'));
        }
    } catch (e) {
        await analyticsLogToFile(ERROR_LOG_FILE_PATH, { type: 'statsReadError', error: e.message });
        return {};
    }
    if (queryParams.formId) {
        const fid = analyticsValidateFormId(queryParams.formId);
        return { [fid]: stats[fid] || {} };
    }
    return stats;
}

async function getErrorReport(dateRange = {}) {
    const lines = await analyticsReadAllLines(ERROR_LOG_FILE_PATH);
    if (!dateRange.start && !dateRange.end) return lines;
    const start = dateRange.start ? new Date(dateRange.start) : null;
    const end = dateRange.end ? new Date(dateRange.end) : null;
    return lines.filter(e => {
        if (!e.timestamp) return false;
        const time = new Date(e.timestamp);
        if (isNaN(time)) return false;
        if (start && time < start) return false;
        if (end && time > end) return false;
        return true;
    });
}

async function exportAnalytics(format = 'json', options = {}) {
    let lines = await analyticsReadAllLines(ANALYTICS_LOG_FILE_PATH);
    lines = lines.map(ev => {
        const safe = {};
        for (const key of Object.keys(ev)) {
            if (typeof ev[key] === 'string') {
                safe[key] = analyticsSanitizeString(ev[key], 512);
            } else {
                safe[key] = ev[key];
            }
        }
        return safe;
    });

    let stats = {};
    try {
        if (fs.existsSync(STATS_DB_FILE_PATH))
            stats = JSON.parse(await fs.promises.readFile(STATS_DB_FILE_PATH, 'utf8'));
    } catch (e) {
        await analyticsLogToFile(ERROR_LOG_FILE_PATH, { type: 'statsReadError', error: e.message });
    }

    if (format === 'json') {
        return JSON.stringify({ events: lines, stats }, null, 2);
    }
    if (format === 'csv') {
        const fields = Object.keys((lines[0] || {}));
        try {
            return await parseAsync(lines, { fields }); // parseAsync from json2csv
        } catch (e) {
            await analyticsLogToFile(ERROR_LOG_FILE_PATH, { type: 'csvExportError', error: e.message });
            throw e;
        }
    }
    if (format === 'xml') {
        const toXmlValue = v => String(v).replace(/[<>&'"]/g, ch => ({
            '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
        })[ch]);
        const items = lines.map(l => {
            return '<event>' + Object.entries(l).map(([k, v]) =>
                `<${k}>${toXmlValue(v)}</${k}>`
            ).join('') + '</event>';
        }).join('');
        return `<analytics>${items}</analytics>`;
    }
    throw new Error('Unsupported export format');
}

// End of contents from analytics.js


// Contents from google-sheets-connector.js
class GoogleSheetsConnectorService extends EventEmitter { // Renamed class
    constructor() {
        super();
        this.sheets = null;
        this.auth = null;
        this.pollIntervals = {};
    }

    async initGoogleAuth(config) { // config for this service
        if (config.type === 'service_account') {
            const jwt = new google.auth.JWT( // google is from require('googleapis')
                config.client_email,
                null,
                config.private_key.replace(/\\n/g, '\n'),
                [
                    'https://www.googleapis.com/auth/spreadsheets',
                    'https://www.googleapis.com/auth/drive'
                ]
            );
            await jwt.authorize();
            this.auth = jwt;
            this.sheets = google.sheets({ version: 'v4', auth: jwt });
        } else if (config.installed || config.web) {
            const credentials = config.installed || config.web;
            const oAuth2Client = new google.auth.OAuth2(
                credentials.client_id,
                credentials.client_secret,
                credentials.redirect_uris[0]
            );
            if (config.token) {
                oAuth2Client.setCredentials(config.token);
            } else {
                throw new Error('OAuth token needed for user account (GoogleSheetsConnectorService).');
            }
            this.auth = oAuth2Client;
            this.sheets = google.sheets({ version: 'v4', auth: oAuth2Client });
        } else {
            throw new Error('Invalid Google API credentials for GoogleSheetsConnectorService.');
        }
         console.log("GoogleSheetsConnectorService initialized successfully.");
    }

    async fetchSpreadsheetData(sheetId, range) {
        this._ensureInitialized();
        const res = await this.sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range,
        });
        return res.data.values || [];
    }

    async saveMappingToSheet(sheetId, mappingData) {
        this._ensureInitialized();
        let values = mappingData;
        if (!Array.isArray(mappingData[0])) {
            values = [mappingData];
        }
        try {
            await this.sheets.spreadsheets.values.append({
                spreadsheetId: sheetId,
                range: 'A1', // Appending from A1. Consider making range configurable.
                valueInputOption: 'RAW',
                insertDataOption: 'INSERT_ROWS',
                resource: { values },
            });
        } catch (err) {
            console.error("GoogleSheetsConnectorService: Error saving to sheet", err);
            throw err;
        }
    }

    listenForSheetUpdates(sheetId, callback, range = 'A1:Z1000', intervalMs = 5000) {
        this._ensureInitialized();
        const normRange = (range || '').trim().toUpperCase();
        const intervalKey = `${sheetId}_${normRange}`;
        if (this.pollIntervals[intervalKey]) return;

        let lastData = null;

        const poll = async () => {
            try {
                const data = await this.fetchSpreadsheetData(sheetId, range);
                const serialized = JSON.stringify(data);
                if (lastData !== null && lastData !== serialized) {
                    callback(data);
                }
                lastData = serialized;
            } catch (err) {
                console.error(`GoogleSheetsConnectorService: Error polling sheet ${sheetId}, range ${range}:`, err);
                this.emit('error', { source: 'GoogleSheetsConnectorService', error: err, sheetId, range });
            }
        };

        poll(); // Initial poll
        this.pollIntervals[intervalKey] = setInterval(poll, intervalMs);
        console.log(`GoogleSheetsConnectorService: Listening for updates on sheet ${sheetId}, range ${range}`);
    }

    stopListeningForSheetUpdates(sheetId, range = 'A1:Z1000') {
        const normRange = (range || '').trim().toUpperCase();
        const intervalKey = `${sheetId}_${normRange}`;
        if (this.pollIntervals[intervalKey]) {
            clearInterval(this.pollIntervals[intervalKey]);
            delete this.pollIntervals[intervalKey];
            console.log(`GoogleSheetsConnectorService: Stopped listening for updates on sheet ${sheetId}, range ${normRange}`);
        }
    }

    async importBatchProfiles(sheetId, range) {
        this._ensureInitialized();
        const rows = await this.fetchSpreadsheetData(sheetId, range);
        if (!rows || rows.length === 0) return [];
        const headers = rows[0];
        return rows.slice(1).map(row => {
            const obj = {};
            headers.forEach((h, i) => { obj[h] = row[i] || ''; });
            return obj;
        });
    }

    _ensureInitialized() {
        if (!this.sheets) throw new Error('GoogleSheetsConnectorService not initialized. Call initGoogleAuth first.');
    }
}
const googleSheetsServiceInstance = new GoogleSheetsConnectorService(); // Export instance
// End of contents from google-sheets-connector.js


// Contents from notifications.js
class NotificationManagerService extends EventEmitter { // Renamed class
    constructor() {
        super();
        this.notifications = new Map(); // Stores active notifications
    }

    sendNotification(message, options = {}) {
        const id = uuidv4(); // uuidv4 from require('uuid')
        const notification = {
            id,
            message,
            type: options.type || 'info',
            userId: options.userId || (options.data && options.data.userId) || null,
            timestamp: Date.now(),
            data: options.data || null,
            persistent: !!options.persistent, // Default to false if not provided
            read: false
        };
        this.notifications.set(id, notification);
        this.emit('notification', notification); // General event for any new notification
        if (notification.type) {
            this.emit(`alertType:${notification.type}`, notification); // Specific event for alert type
        }
        // console.log(`Notification sent: ${id}, message: ${message}`);
        return id;
    }

    streamRealTimeNotifications(userId, timeoutMs = 60 * 60 * 1000) {
        const stream = new EventEmitter();
        const onNotify = (notification) => {
            if (!notification.userId || notification.userId === userId) {
                stream.emit('data', notification);
            }
        };
        this.on('notification', onNotify);

        let cleanedUp = false;
        const cleanup = () => {
            if (!cleanedUp) {
                cleanedUp = true;
                this.removeListener('notification', onNotify);
                stream.emit('close');
                stream.removeAllListeners();
                // console.log(`Notification stream closed for user: ${userId}`);
            }
        };
        stream.close = cleanup;

        const timeout = setTimeout(() => {
            // console.log(`Notification stream timed out for user: ${userId}`);
            cleanup();
        }, timeoutMs);

        stream.on('close', () => clearTimeout(timeout));
        // console.log(`Notification stream opened for user: ${userId}`);
        return stream;
    }

    subscribeToAlertType(type, callback) {
        const key = `alertType:${type}`;
        this.on(key, callback);
        // console.log(`Subscribed to alert type: ${type}`);
        return () => {
            this.removeListener(key, callback);
            // console.log(`Unsubscribed from alert type: ${type}`);
        };
    }

    dismissNotification(id) {
        const notification = this.notifications.get(id);
        if (notification) {
            this.notifications.delete(id);
            this.emit('dismiss', id);
            // console.log(`Notification dismissed: ${id}`);
            return true;
        }
        // console.log(`Attempted to dismiss non-existent notification: ${id}`);
        return false;
    }

    getAllActive() {
        return Array.from(this.notifications.values());
    }
}
const notificationServiceInstance = new NotificationManagerService(); // Export instance
// End of contents from notifications.js


module.exports = {
    // Analytics exports
    logSubmissionEvent,
    trackFormInteraction,
    aggregateStats,
    getErrorReport,
    exportAnalytics,

    // Google Sheets Service export
    googleSheetsServiceInstance, // Exporting the instance
    // If the class itself is needed for multiple instances: GoogleSheetsConnectorService,

    // Notification Service export
    notificationServiceInstance, // Exporting the instance
    // If the class itself is needed: NotificationManagerService,

    // Placeholders for other services
};
