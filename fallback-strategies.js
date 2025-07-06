const fallbackHandlers = {
    config: null,
    initialized: false
};

/**
 * Initializes fallback handler configuration.
 * @param {Object} config 
 */
function initFallbackHandlers(config) {
    fallbackHandlers.config = config || {};
    fallbackHandlers.initialized = true;
}

/**
 * Handles situations where form detection fails.
 * - Logs the event
 * - Attempts fallback strategies: solve captcha, simulate alternative interactions
 * @param {Object} context - Should contain at minimum { page } (e.g. Puppeteer page object or content script context)
 */
async function handleFormDetectionFailure(context) {
    if (!fallbackHandlers.initialized) {
        throw new Error('Fallback handlers not initialized');
    }
    logFallbackEvent({
        type: 'form-detection-failure',
        timestamp: Date.now(),
        details: context
    });

    if (context && typeof context.page !== 'undefined') {
        await invokeCaptchaSolver(context);

        // Try alternative interaction based on environment:
        // In a browser/env with DOM, interact directly; for headless/browser context, use page.evaluate
        let alternativeForms = [];
        if (isBrowserContext()) {
            alternativeForms = queryAlternativeFormsDOM();
            for (const formEl of alternativeForms) {
                await simulateAlternativeInteraction(formEl);
            }
        } else if (isAutomationPage(context.page)) {
            // likely headless (e.g. Puppeteer) - interact in page context
            alternativeForms = await queryAlternativeFormsRemote(context.page);
            for (const formMeta of alternativeForms) {
                await simulateAlternativeInteractionRemote(context.page, formMeta.index);
            }
        }
    }
}

/**
 * Invokes a CAPTCHA solver, if available in pageContext.
 * @param {Object} pageContext - Should have a solveCaptcha function
 */
async function invokeCaptchaSolver(pageContext) {
    if (!pageContext || typeof pageContext.solveCaptcha !== 'function') return;
    try {
        const result = await pageContext.solveCaptcha();
        logFallbackEvent({
            type: 'captcha-solver-attempt',
            timestamp: Date.now(),
            success: result === true,
            pageUrl: pageContext.url || null
        });
        return result;
    } catch (err) {
        logFallbackEvent({
            type: 'captcha-solver-error',
            timestamp: Date.now(),
            error: err && err.message || String(err),
            pageUrl: pageContext.url || null
        });
        return false;
    }
}

/**
 * Simulates human interaction with a form element in DOM context.
 * @param {HTMLFormElement} formElement 
 */
async function simulateAlternativeInteraction(formElement) {
    try {
        if (!isBrowserContext() || !formElement || typeof formElement.querySelectorAll !== 'function') return;

        // Focus and blur each input-like field, if possible.
        const inputs = formElement.querySelectorAll('input, textarea, select');
        for (let el of inputs) {
            if (typeof el.focus === 'function') el.focus();
            await delay(120 + Math.random() * 180);
            if (typeof el.blur === 'function') el.blur();
        }
        // Trigger the form submission.
        if (typeof formElement.submit === 'function') {
            formElement.submit();
        } else {
            const evt = document.createEvent
                ? document.createEvent('Event')
                : null;
            if (evt) {
                evt.initEvent('submit', true, true);
                formElement.dispatchEvent(evt);
            } else if (typeof Event === 'function') {
                formElement.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            }
        }
        logFallbackEvent({
            type: 'alternative-interaction',
            timestamp: Date.now(),
            formAction: formElement.action || null
        });
    } catch (err) {
        logFallbackEvent({
            type: 'alternative-interaction-error',
            timestamp: Date.now(),
            error: err && err.message || String(err)
        });
    }
}

/**
 * Simulates human interaction with a form at a given index by running logic inside the page (headless/browser automation).
 * @param {Object} page - Automation page context, e.g. Puppeteer "page"
 * @param {number} index - Index of form in document.forms
 */
async function simulateAlternativeInteractionRemote(page, index) {
    if (!isAutomationPage(page)) return;
    try {
        await page.evaluate(async (formIdx) => {
            try {
                const delay = ms => new Promise(res => setTimeout(res, ms));
                const forms = Array.from(document.forms);
                const form = forms[formIdx];
                if (!form) return;
                const inputs = form.querySelectorAll('input, textarea, select');
                for (let el of inputs) {
                    if (typeof el.focus === 'function') el.focus();
                    await delay(120 + Math.random() * 180);
                    if (typeof el.blur === 'function') el.blur();
                }
                if (typeof form.submit === 'function') {
                    form.submit();
                } else {
                    // Old browsers: create and dispatch submit event
                    const evt = document.createEvent
                        ? document.createEvent('Event')
                        : null;
                    if (evt) {
                        evt.initEvent('submit', true, true);
                        form.dispatchEvent(evt);
                    } else if (typeof Event === 'function') {
                        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                    }
                }
            } catch (err) {
                // Errors here can't be externally logged, just swallow
            }
        }, index);
        logFallbackEvent({
            type: 'alternative-interaction-remote',
            timestamp: Date.now(),
            formIndex: index
        });
    } catch (err) {
        logFallbackEvent({
            type: 'alternative-interaction-remote-error',
            timestamp: Date.now(),
            error: err && err.message || String(err),
            formIndex: index
        });
    }
}

/**
 * Logs fallback event with error handling; logs log failures to stderr if available.
 * @param {Object} eventData 
 */
function logFallbackEvent(eventData) {
    try {
        const logMessage = `[Fallback][${new Date(eventData.timestamp).toISOString()}] ${eventData.type} ${JSON.stringify(eventData)}`;
        if (typeof window !== 'undefined' && window && window.console) {
            window.console.log(logMessage);
        } else if (typeof console !== 'undefined' && typeof console.log === 'function') {
            console.log(logMessage);
        }
        // TODO: persist to .log file or remote logger if environment allows
    } catch (err) {
        // Fallback: log error to stderr if possible
        try {
            if (typeof process !== 'undefined' && process.stderr && typeof process.stderr.write === 'function') {
                process.stderr.write(`[Fallback][LOGGER-ERROR] ${err && err.message || String(err)}\n`);
            }
        } catch (e2) {
            // Silent, last resort
        }
    }
}

/**
 * Returns true if this script is running in a browser DOM context.
 */
function isBrowserContext() {
    return (typeof window !== 'undefined') && (typeof document !== 'undefined') && (typeof document.querySelectorAll === 'function');
}

/**
 * Returns true if the page parameter is a browser automation context (e.g. Puppeteer page).
 * @param {any} page 
 */
function isAutomationPage(page) {
    // Conservative check for Puppeteer/Playwright "page" objects
    return !!(page && typeof page.evaluate === 'function');
}

/**
 * Query alternative forms in DOM (content script/browser context).
 * Returns an array of HTMLFormElement.
 */
function queryAlternativeFormsDOM() {
    if (!isBrowserContext() || !document.forms) return [];
    // Optionally, filter on visibility or type
    return Array.from(document.forms);
}

/**
 * Query alternative forms in automation (headless/remote page context).
 * Returns array of form meta info {action, id, name, index}
 * Suitable for passing indexes into page.evaluate for remote handling.
 * @param {Object} page 
 */
async function queryAlternativeFormsRemote(page) {
    if (!isAutomationPage(page)) return [];
    try {
        const forms = await page.evaluate(() =>
            Array.from(document.forms || []).map((f, idx) => ({
                action: f.action || null,
                id: f.id || null,
                name: f.name || null,
                index: idx
            }))
        );
        // Optionally, filter or rank forms (by action, id, name, etc.)
        return forms;
    } catch (err) {
        logFallbackEvent({
            type: 'alternative-forms-query-remote-error',
            timestamp: Date.now(),
            error: err && err.message || String(err)
        });
        return [];
    }
}

/**
 * Delays for a specified time (ms).
 * @param {number} ms
 * @returns {Promise}
 */
function delay(ms) {
    return new Promise(res => setTimeout(res, ms));
}

module.exports = {
    initFallbackHandlers,
    handleFormDetectionFailure,
    invokeCaptchaSolver,
    simulateAlternativeInteraction,
    logFallbackEvent,
    // Exported for integration/test/library usage
    simulateAlternativeInteractionRemote,
    queryAlternativeFormsRemote,
    queryAlternativeFormsDOM
};