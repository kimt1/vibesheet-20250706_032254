const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

// In-memory batch state and progress tracking
const batches = new Map();
const BATCH_STATE_FILE = path.resolve(__dirname, 'batch-state.json');

function persistBatchState() {
    try {
        fs.writeFileSync(BATCH_STATE_FILE, JSON.stringify([...batches.entries()]), 'utf-8');
    } catch (err) {
        console.error('Failed to persist batch state:', err);
    }
}

function loadBatchState() {
    if (fs.existsSync(BATCH_STATE_FILE)) {
        try {
            const entries = JSON.parse(fs.readFileSync(BATCH_STATE_FILE, 'utf-8'));
            for (const [id, data] of entries) {
                batches.set(id, data);
            }
        } catch (err) {
            // Corrupted or unreadable file, fallback to in-memory only
            console.warn('Could not load batch state:', err);
        }
    }
}

loadBatchState();

class BatchEventEmitter extends EventEmitter {}
const batchEmitter = new BatchEventEmitter();

function scheduleBatchRun(profile, batchConfig) {
    const batchId = uuidv4();
    const batch = {
        id: batchId,
        profile,
        batchConfig,
        inputRows: [],
        status: 'scheduled',
        progress: { total: 0, processed: 0, failed: 0, succeeded: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        logs: [],
        summary: null,
        failures: [],
        retries: []
    };
    batches.set(batchId, batch);
    persistBatchState();
    logBatchEvent(batchId, 'scheduled', { profile, batchConfig });
    return batchId;
}

async function executeBatch(profile, inputRows) {
    // Find the scheduled batch for this profile
    const batchEntry = [...batches.values()].find(
        b => b.profile === profile && b.status === 'scheduled'
    );
    if (!batchEntry) throw new Error(i18n('No scheduled batch for this profile.'));

    batchEntry.inputRows = inputRows;
    batchEntry.progress.total = inputRows.length;
    batchEntry.status = 'running';
    batchEntry.updatedAt = Date.now();
    persistBatchState();

    batchEmitter.emit('batchStarted', batchEntry.id);
    logBatchEvent(batchEntry.id, 'started', { total: inputRows.length });
    const results = [];
    const failures = [];
    for (const [idx, row] of inputRows.entries()) {
        try {
            // Simulate form processing:
            const result = await processForm(batchEntry.profile, row);
            results.push(result);
            batchEntry.progress.succeeded += 1;
        } catch (err) {
            failures.push({ row, profile: batchEntry.profile, error: err.message, attempt: 1 });
            batchEntry.progress.failed += 1;
            logBatchEvent(batchEntry.id, 'rowFailure', { idx, error: err.message, row });
        }
        batchEntry.progress.processed += 1;
        batchEntry.updatedAt = Date.now();
        persistBatchState();
        batchEmitter.emit('progress', batchEntry.id, { ...batchEntry.progress });
    }
    batchEntry.failures = failures;
    batchEntry.status = failures.length === 0 ? 'completed' : 'failed';
    batchEntry.updatedAt = Date.now();
    batchEntry.summary = {
        total: inputRows.length,
        succeeded: batchEntry.progress.succeeded,
        failed: batchEntry.progress.failed,
        completedAt: Date.now()
    };
    persistBatchState();
    logBatchEvent(batchEntry.id, 'completed', batchEntry.summary);
    batchEmitter.emit('batchCompleted', batchEntry.id, batchEntry.summary);
    return { batchId: batchEntry.id, results, failures: batchEntry.failures };
}

async function retryFailedSubmissions(failures, retryPolicy) {
    const maxAttempts = retryPolicy.maxAttempts || 3;
    const retryDelay = retryPolicy.retryDelayMs || 1000;
    const finalResults = [];
    const newFailures = [];
    for (const failure of failures) {
        let attempt = failure.attempt || 1;
        let lastError = failure.error;
        let succeeded = false;
        while (attempt <= maxAttempts && !succeeded) {
            try {
                await delay(retryDelay);
                const result = await processForm(failure.profile, failure.row);
                finalResults.push(result);
                succeeded = true;
            } catch (err) {
                lastError = err.message;
                logBatchEvent('NA', 'retryFailure', {
                    profile: failure.profile,
                    error: lastError,
                    row: failure.row,
                    attempt
                });
                attempt += 1;
            }
        }
        if (!succeeded) {
            newFailures.push({ ...failure, error: lastError, attempt });
        }
    }
    return { succeeded: finalResults, failures: newFailures };
}

function trackBatchProgress(batchId) {
    return batches.get(batchId) ? { ...batches.get(batchId).progress } : null;
}

function handleBatchCompletion(batchId, summary) {
    const batch = batches.get(batchId);
    if (!batch) return;
    batch.status = 'completed';
    batch.summary = summary;
    batch.updatedAt = Date.now();
    persistBatchState();
    logBatchEvent(batchId, 'finalized', summary);
    batchEmitter.emit('batchFinalized', batchId, summary);
}

// Helpers

async function processForm(profile, row) {
    // Actual implementation would interact with automation backend or plugin modules
    if (Math.random() < 0.9) {
        await delay(120 + Math.random() * 80);
        return { profile, row, status: 'success' };
    } else {
        throw new Error(i18n('Simulated form submission error'));
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Logging utility (to .log file)
function logBatchEvent(batchId, event, data) {
    try {
        const logPath = path.resolve(__dirname, 'batch-processor.log');
        const stamp = new Date().toISOString();
        const safeBatchId = batchId !== undefined && batchId !== null ? batchId : 'NA';
        const entry = `[${stamp}][Batch:${safeBatchId}][${event}] ${JSON.stringify(data)}\n`;
        fs.appendFileSync(logPath, entry, 'utf8');
    } catch (err) {
        // Avoid crashing batch processor due to logging error
        // Optionally, could report to central error logging
        // console.error('Batch logging failed:', err);
    }
}

// i18n (placeholder for integration with .pot)
function i18n(key) {
    // Extend as needed for real i18n, e.g. with .pot file loading and translation table
    return key;
}

module.exports = {
    scheduleBatchRun,
    executeBatch,
    retryFailedSubmissions,
    trackBatchProgress,
    handleBatchCompletion,
    batchEmitter,
    logBatchEvent,
    i18n
};