const fs = require('fs');
const path = require('path');
const { parseAsync } = require('json2csv');

// Paths
const ANALYTICS_LOG = path.resolve(__dirname, 'analytics.log');
const ERROR_LOG = path.resolve(__dirname, 'analytics_error.log');
const STATS_DB = path.resolve(__dirname, 'analytics_stats.json');

// --- Input Validation/Sanitization Helpers ---

function isValidString(val, maxLength = 128) {
    return typeof val === 'string' && val.length > 0 && val.length <= maxLength && !/[<>]/.test(val);
}
function sanitizeString(val, maxLength = 512) {
    if (typeof val !== 'string') return '';
    // Remove control chars, angle brackets, force string
    return val.replace(/[\x00-\x08\x0E-\x1F\x7F<>]/g, '').substring(0, maxLength);
}
function cleanEventData(eventData) {
    if (typeof eventData !== 'object' || eventData === null) return {};
    const cleaned = {};
    if (isValidString(eventData.formId)) cleaned.formId = sanitizeString(eventData.formId, 128);
    if (isValidString(eventData.userId || '')) cleaned.userId = sanitizeString(eventData.userId, 128);
    if (eventData.fields && typeof eventData.fields === 'object') {
        cleaned.fields = {};
        for (const k of Object.keys(eventData.fields)) {
            if (isValidString(k, 64)) cleaned.fields[sanitizeString(k, 64)] = sanitizeString(eventData.fields[k], 256);
        }
    }
    if (eventData.success !== undefined) cleaned.success = !!eventData.success;
    if (eventData.errorCode && isValidString(eventData.errorCode, 32))
        cleaned.errorCode = sanitizeString(eventData.errorCode, 32);
    if (eventData.errorMessage && isValidString(eventData.errorMessage, 512))
        cleaned.errorMessage = sanitizeString(eventData.errorMessage, 512);
    // Include timestamp if sent (never trust, but may be needed for replay logs)
    if (eventData.timestamp) cleaned.timestamp = new Date(eventData.timestamp).toISOString();
    // Preserve whitelisted custom attributes (add as needed)
    if (eventData.meta && typeof eventData.meta === 'object') cleaned.meta = eventData.meta;
    return cleaned;
}
function cleanInteractionData(data) {
    // Allow userId, field, value, meta
    const cleaned = {};
    if (data.field && isValidString(data.field, 64))
        cleaned.field = sanitizeString(data.field, 64);
    if (data.value && isValidString(data.value, 256))
        cleaned.value = sanitizeString(data.value, 256);
    if (isValidString(data.userId || ''))
        cleaned.userId = sanitizeString(data.userId, 128);
    if (data.meta && typeof data.meta === 'object')
        cleaned.meta = data.meta;
    return cleaned;
}
function validateFormId(formId) {
    return isValidString(formId) ? sanitizeString(formId, 128) : null;
}

// --- Async File Operations with Error Logging ---

async function logToFile(filepath, data) {
    try {
        const line = JSON.stringify({ ...data, timestamp: new Date().toISOString() }) + '\n';
        await fs.promises.appendFile(filepath, line, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
        // Log error to error log file
        try {
            const errData = { logError: err.message || String(err), originalData: (data && data.type) ? data.type : undefined, filepath, timestamp: new Date().toISOString() };
            await fs.promises.appendFile(ERROR_LOG, JSON.stringify(errData) + '\n', { encoding: 'utf8', mode: 0o600 });
        } catch {} // Silently ignore, last resort
    }
}

async function readAllLines(filepath) {
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
                    // Corrupted log line, log the error
                    logToFile(ERROR_LOG, { type: 'parseError', error: e.message, raw: line });
                    return null;
                }
            })
            .filter(Boolean);
    } catch (e) {
        await logToFile(ERROR_LOG, { type: 'readError', error: e.message, filepath });
        return [];
    }
}

// Uses in-memory locking to avoid concurrency bug with overwrites
let statsDbWriteLock = Promise.resolve();

async function aggregateStatUpdate(eventType, formId) {
    formId = validateFormId(formId);
    if (!formId) return; // Invalid, ignore
    await (statsDbWriteLock = statsDbWriteLock.then(async () => {
        let stats = {};
        try {
            if (fs.existsSync(STATS_DB)) {
                const raw = await fs.promises.readFile(STATS_DB, 'utf8');
                stats = JSON.parse(raw);
            }
        } catch (e) {
            stats = {};
            await logToFile(ERROR_LOG, { type: 'statsReadError', error: e.message });
        }
        stats[formId] = stats[formId] || { submission: 0, interaction: 0, lastEvent: null };
        if (!['submission', 'interaction'].includes(eventType)) return; // do not allow unknown eventType
        stats[formId][eventType] = (stats[formId][eventType] || 0) + 1;
        stats[formId].lastEvent = new Date().toISOString();
        try {
            await fs.promises.writeFile(STATS_DB, JSON.stringify(stats, null, 2), 'utf8');
        } catch (e) {
            await logToFile(ERROR_LOG, { type: 'statsWriteError', error: e.message });
        }
    }));
}

async function logSubmissionEvent(eventData) {
    const cleanedData = cleanEventData(eventData);
    if (!cleanedData.formId) {
        await logToFile(ERROR_LOG, { type: 'invalidEvent', event: 'submission', eventData });
        return;
    }
    await logToFile(ANALYTICS_LOG, { type: 'submission', ...cleanedData });
    await aggregateStatUpdate('submission', cleanedData.formId);
}

async function trackFormInteraction(formId, data = {}) {
    formId = validateFormId(formId);
    if (!formId) {
        await logToFile(ERROR_LOG, { type: 'invalidEvent', event: 'interaction', formId, data });
        return;
    }
    const cleanedData = cleanInteractionData(data);
    await logToFile(ANALYTICS_LOG, { type: 'interaction', formId, ...cleanedData });
    await aggregateStatUpdate('interaction', formId);
}

async function aggregateStats(queryParams = {}) {
    let stats = {};
    try {
        if (fs.existsSync(STATS_DB)) {
            stats = JSON.parse(await fs.promises.readFile(STATS_DB, 'utf8'));
        }
    } catch (e) {
        await logToFile(ERROR_LOG, { type: 'statsReadError', error: e.message });
        return {};
    }
    if (queryParams.formId) {
        const fid = validateFormId(queryParams.formId);
        return { [fid]: stats[fid] || {} };
    }
    return stats;
}

async function getErrorReport(dateRange = {}) {
    // Only allow querying logs (not deleting)
    const lines = await readAllLines(ERROR_LOG);
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

// --- Export Analytics ---

async function exportAnalytics(format = 'json', options = {}) {
    let lines = await readAllLines(ANALYTICS_LOG);
    // Filter out lines with malformed or suspicious content (prevent log injection, etc.)
    lines = lines.map(ev => {
        // Remove raw field content that could contain dangerous chars
        const safe = {};
        for (const key of Object.keys(ev)) {
            if (typeof ev[key] === 'string') {
                safe[key] = sanitizeString(ev[key], 512);
            } else {
                safe[key] = ev[key];
            }
        }
        return safe;
    });

    let stats = {};
    try {
        if (fs.existsSync(STATS_DB))
            stats = JSON.parse(await fs.promises.readFile(STATS_DB, 'utf8'));
    } catch (e) {
        await logToFile(ERROR_LOG, { type: 'statsReadError', error: e.message });
    }

    if (format === 'json') {
        return JSON.stringify({ events: lines, stats }, null, 2);
    }
    if (format === 'csv') {
        const fields = Object.keys((lines[0] || {}));
        try {
            return await parseAsync(lines, { fields });
        } catch (e) {
            await logToFile(ERROR_LOG, { type: 'csvExportError', error: e.message });
            throw e;
        }
    }
    if (format === 'xml') {
        // Safe XML
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

// --- Exports ---

module.exports = {
    logSubmissionEvent,
    trackFormInteraction,
    aggregateStats,
    getErrorReport,
    exportAnalytics
};