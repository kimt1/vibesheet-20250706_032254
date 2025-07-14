const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const crypto = require('crypto');
const os = require('os');
const puppeteer = require('puppeteer');
const csv = require('csv-parser');
const ini = require('ini');
const xml2js = require('xml2js');
const { format } = require('util');
const gettextParser = require('gettext-parser');

// Contents from form-detection-engine.js

const FORM_FIELD_SELECTORS = [
  'input:not([type="hidden"]):not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
];
const FORM_IGNORE_CLASSES = ['hidden', 'invisible', 'display-none'];

// Utility: Checks if an element or its ancestors are hidden
function isHidden(el) {
  let node = el;
  while (node) {
    if (node.nodeType !== 1) break;
    // Ensure element is part of the document before calling getComputedStyle
    if (!node.ownerDocument || !node.ownerDocument.defaultView) {
        return true; // Cannot determine style, assume hidden or detached
    }
    const computed = node.ownerDocument.defaultView.getComputedStyle(node);
    if (
      computed.display === 'none' ||
      computed.visibility === 'hidden' ||
      computed.opacity === '0' ||
      FORM_IGNORE_CLASSES.some((cls) => node.classList.contains(cls)) ||
      (node.hasAttribute('aria-hidden') && node.getAttribute('aria-hidden') !== 'false')
    ) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

// Main: Detect forms within main DOM and within all shadow roots
function detectForms(documentContext) {
  const forms = [];
  const formElems = Array.from(documentContext.querySelectorAll('form'));
  formElems.forEach((form) => {
    if (!isHidden(form)) forms.push(form);
  });
  const shadowForms = detectFormsInShadowDOM(documentContext);
  shadowForms.forEach((f) => forms.push(f));
  // Remove duplicates (i.e., same DOM reference)
  return Array.from(new Set(forms));
}

// Traverse DOM, look for ShadowRoots, recursively find forms within them
function detectFormsInShadowDOM(rootNode) {
  const forms = [];
   if (!rootNode || typeof rootNode.createTreeWalker !== 'function') { // Guard against null/undefined rootNode
    return forms;
  }
  const walker = rootNode.createTreeWalker(
        rootNode,
        NodeFilter.SHOW_ELEMENT, // In browser context, NodeFilter is a global. For Node.js, it would need to be defined or polyfilled if used outside browser.
        null, // No custom filter logic
      );

  if (!walker) return forms;
  do {
    const node = walker.currentNode;
    if (node.shadowRoot) {
      // forms inside shadow root
      const shadowForms = Array.from(node.shadowRoot.querySelectorAll('form'));
      shadowForms.forEach((form) => {
        if (!isHidden(form)) forms.push(form);
      });
      // Descend recursively
      detectFormsInShadowDOM(node.shadowRoot).forEach((f) => forms.push(f));
    }
  } while (walker.nextNode());
  return forms;
}

// Extract metadata about the form's structure, fields, labels etc.
function extractFormMetadata(formElement) {
  const fields = [];
  const usedFields = new Set();
  Array.from(formElement.elements || []).forEach((el) => {
    if (!el.name && !el.id) return;
    if (isHidden(el)) return;
    if (el.disabled) return;
    if (usedFields.has(el)) return;
    usedFields.add(el);
    let label = '';
    if (el.id) {
      const labelElem = formElement.ownerDocument.querySelector(`label[for="${el.id}"]`);
      if (labelElem) label = labelElem.textContent.trim();
    }
    if (!label) {
      const parentLabel = el.closest('label');
      if (parentLabel) label = parentLabel.textContent.trim();
    }
    fields.push({
      name: el.name || '',
      id: el.id || '',
      type: (el.type || el.tagName).toLowerCase(),
      label,
      placeholder: el.placeholder || '',
      required: !!el.required,
      autocomplete: el.autocomplete || '',
      node: el, // This stores a DOM node reference, be mindful if serializing.
    });
  });
  return {
    node: formElement, // DOM node reference
    id: formElement.id || '',
    name: formElement.name || '',
    action: formElement.action || '',
    method: (formElement.method || '').toUpperCase(),
    fields,
  };
}

function suggestMappings(formFields, rules) {
  const suggestions = [];
  formFields.forEach((field) => {
    let bestMatch = null;
    if (rules && Array.isArray(rules)) {
      for (const rule of rules) {
        const fieldNameMatch = (field.name && rule.fieldMatch.test(field.name));
        const fieldIdMatch = (field.id && rule.fieldMatch.test(field.id));
        const fieldLabelMatch = (field.label && rule.fieldMatch.test(field.label));

        const mainMatch = typeof rule.fieldMatch === 'function'
            ? rule.fieldMatch(field)
            : (fieldNameMatch || fieldIdMatch || fieldLabelMatch);

        const typeMatches = !rule.typeMatch ||
            (Array.isArray(rule.typeMatch)
              ? rule.typeMatch.includes(field.type)
              : field.type === rule.typeMatch);

        if (mainMatch && typeMatches) {
          bestMatch = rule.suggest;
          break;
        }
      }
    }
    if (bestMatch) {
      suggestions.push({ field, mapping: bestMatch });
    } else {
      suggestions.push({ field, mapping: null }); // No suggestion or default
    }
  });
  return suggestions;
}

function fallbackVisualDetection(domSnapshot) {
  const controls = [];
  FORM_FIELD_SELECTORS.forEach(sel => {
    controls.push(...Array.from(domSnapshot.querySelectorAll(sel)));
  });
  const visibleControls = controls.filter(
    (el) => !isHidden(el) && !el.disabled
  );
  if (visibleControls.length === 0) return [];
  visibleControls.sort((a, b) => {
    const rectA = a.getBoundingClientRect();
    const rectB = b.getBoundingClientRect();
    return rectA.top - rectB.top;
  });
  const clusterForms = [];
  let cluster = [];
  let lastBottom = null;
  visibleControls.forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (
      lastBottom === null ||
      Math.abs(rect.top - lastBottom) < 60
    ) {
      cluster.push(el);
      lastBottom = rect.bottom;
    } else {
      if (cluster.length >= 2) clusterForms.push(cluster.slice());
      cluster = [el];
      lastBottom = rect.bottom;
    }
  });
  if (cluster.length >= 2) clusterForms.push(cluster);
  return clusterForms.map((clusterEls, idx) => {
    const fields = clusterEls.map((el) => ({
      name: el.name || '',
      id: el.id || '',
      type: (el.type || el.tagName).toLowerCase(),
      label: '',
      placeholder: el.placeholder || '',
      required: !!el.required,
      autocomplete: el.autocomplete || '',
      node: el,
    }));
    return {
      node: null,
      id: `synthetic-form-${idx}`, // Provide a synthetic ID
      name: `syntheticForm${idx}`, // Provide a synthetic name
      action: '',
      method: 'POST', // Default method
      synthetic: true,
      fields,
    };
  });
}

// Placeholder for NodeFilter if not in a browser environment
// This is a very basic polyfill. A more complete one might be needed for complex filters.
if (typeof NodeFilter === 'undefined') {
  global.NodeFilter = {
    SHOW_ELEMENT: 1,
    // Add other NodeFilter constants if used by the application
  };
}

// This entire block, which was a misplaced module.exports object, is being removed.

// End of contents from form-detection-engine.js


// Contents from human-simulation.js

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function addRandomization(config = {}) {
  return {
    typing: {
      minDelay: config.typing?.minDelay || 60,
      maxDelay: config.typing?.maxDelay || 160,
      errorRate: config.typing?.errorRate || 0.03,
      correctionDelay: config.typing?.correctionDelay || [200, 500],
    },
    mouse: {
      moveDelay: config.mouse?.moveDelay || [80, 200],
      clickDelay: config.mouse?.clickDelay || [90, 270],
      jitter: config.mouse?.jitter || 1.9,
    },
    scroll: {
      scrollDelay: config.scroll?.scrollDelay || [60, 180],
      scrollJitter: config.scroll?.scrollJitter || 12,
    }
  };
}

/**
 * Simulates human-like typing into a field.
 * @param {HTMLInputElement|HTMLTextAreaElement} field - The input or textarea element to type into.
 * @param {string} value - The string value to type.
 * @param {object} [options] - Optional randomization config.
 */
async function simulateTyping(field, value, options = {}) {
  const opts = addRandomization(options);
  if (typeof field.focus === 'function') {
    field.focus();
  }

  let text = '';
  for (let i = 0; i < value.length; i++) {
    text += value[i];
    field.value = text;
    // Ensure InputEvent is available (browser context) or handle otherwise for Node.js tests
    if (typeof InputEvent !== 'undefined') {
      field.dispatchEvent(new InputEvent('input', {bubbles: true}));
    } else {
        // Fallback or special handling if InputEvent is not available
        // For Node.js context, this might involve directly setting value and relying on other event triggers if applicable
    }


    if (opts.typing.errorRate > 0 && Math.random() < opts.typing.errorRate) {
      // Simulate mistyping a random character
      const errorChar = String.fromCharCode(97 + Math.floor(Math.random() * 26));
      field.value = text + errorChar;
      if (typeof InputEvent !== 'undefined') {
        field.dispatchEvent(new InputEvent('input', {bubbles: true}));
      }
      await delay(randomBetween(...opts.typing.correctionDelay));
      field.value = text;
      if (typeof InputEvent !== 'undefined') {
        field.dispatchEvent(new InputEvent('input', {bubbles: true}));
      }
    }

    await delay(randomBetween(opts.typing.minDelay, opts.typing.maxDelay));
  }
   if (typeof Event !== 'undefined') {
    field.dispatchEvent(new Event('change', {bubbles: true}));
  }
}

/**
 * Simulates mouse interaction (move, click, doubleClick, focus) on an element.
 * @param {HTMLElement} element - The DOM element to interact with.
 * @param {('click'|'doubleClick'|'focus')} [action='click'] - The mouse action to simulate.
 * @param {object} [options] - Optional randomization config.
 */
async function simulateMouseInteraction(element, action = 'click', options = {}) {
  const opts = addRandomization(options);

  if (!element || typeof element.getBoundingClientRect !== 'function') return;

  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2 + randomBetween(-opts.mouse.jitter, opts.mouse.jitter);
  const y = rect.top + rect.height / 2 + randomBetween(-opts.mouse.jitter, opts.mouse.jitter);

  // Simulate mouse movement (in steps)
  const moveSteps = 6 + Math.floor(Math.random() * 4);
  for (let i = 1; i <= moveSteps; i++) {
    const stepX = rect.left + (rect.width / 2) * i / moveSteps + randomBetween(-opts.mouse.jitter, opts.mouse.jitter);
    const stepY = rect.top + (rect.height / 2) * i / moveSteps + randomBetween(-opts.mouse.jitter, opts.mouse.jitter);
    if (typeof MouseEvent !== 'undefined') {
      element.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: stepX, clientY: stepY, buttons: 0
      }));
    }
    await delay(randomBetween(...opts.mouse.moveDelay));
  }

  if (action === 'click' || action === 'doubleClick') {
    if (typeof MouseEvent !== 'undefined') {
      element.dispatchEvent(new MouseEvent('mouseover', {bubbles: true, clientX: x, clientY: y}));
      element.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, clientX: x, clientY: y, button: 0}));
      await delay(randomBetween(...opts.mouse.clickDelay));
      element.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, clientX: x, clientY: y, button: 0}));
      element.dispatchEvent(new MouseEvent('click', {bubbles: true, clientX: x, clientY: y, button: 0}));
      if (action === 'doubleClick') {
        await delay(randomBetween(...opts.mouse.clickDelay));
        element.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, clientX: x, clientY: y, button: 0}));
        element.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, clientX: x, clientY: y, button: 0}));
        element.dispatchEvent(new MouseEvent('click', {bubbles: true, clientX: x, clientY: y, button: 0}));
        element.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, clientX: x, clientY: y, button: 0}));
      }
    }
  }
  if (action === 'focus' && typeof element.focus === 'function') {
    element.focus();
  }
}

/**
 * Simulates human-like scrolling in a container or window.
 * @param {HTMLElement|Window|undefined} element - Container to scroll, or window/document to scroll window.
 * @param {object} [options] - Optional randomization config.
 */
async function simulateScrolling(element, options = {}) {
  const opts = addRandomization(options);
  let targetScroll = 0; // Renamed to avoid conflict with 'target' element if element is 'window'
  let isWindowScroll = false; // Renamed to avoid conflict

  // Check if element is window or document.body for global scroll
  // Ensure window and document are defined (browser context)
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (element === window || element === document.body || !element) {
      element = window; // Standardize to window for global scroll
      isWindowScroll = true;
      targetScroll = document.body.scrollHeight - window.innerHeight - randomBetween(0, opts.scroll.scrollJitter);
    } else {
      targetScroll = element.scrollHeight - element.clientHeight - randomBetween(0, opts.scroll.scrollJitter);
    }
  } else if (element && typeof element.scrollHeight === 'number' && typeof element.clientHeight === 'number') {
      // Fallback for non-browser environments if element has scroll properties
      targetScroll = element.scrollHeight - element.clientHeight - randomBetween(0, opts.scroll.scrollJitter);
  } else {
      // Cannot determine scroll target
      return;
  }


  const scrollSteps = Math.max(8, Math.floor(Math.abs(targetScroll) / 80));
  for (let i = 0; i <= scrollSteps; i++) {
    const progress = i / scrollSteps;
    const curr = Math.floor(progress * targetScroll + randomBetween(-opts.scroll.scrollJitter, opts.scroll.scrollJitter));
    if (isWindowScroll) {
      // This will only work in a browser context where window.scrollTo is available
      if(typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
        window.scrollTo(0, curr);
      }
    } else if (element && typeof element.scrollTop === 'number') {
      element.scrollTop = curr;
    }
    await delay(randomBetween(...opts.scroll.scrollDelay));
  }
}

/**
 * Simulates submitting a form with human interactions.
 * Prefer click on submit button (if present), fallback to native submit event.
 * @param {HTMLFormElement} formElement - The form element to submit.
 * @param {object} [options] - Optional randomization config.
 */
async function simulateFormSubmission(formElement, options = {}) {
  const opts = addRandomization(options);
  if (!formElement || typeof formElement.querySelector !== 'function') return;
  const submitButton = formElement.querySelector('[type="submit"], button:not([type]), button[type="submit"]');
  if (submitButton) {
    await simulateMouseInteraction(submitButton, 'click', opts);
    await delay(randomBetween(100, 300));
  } else {
    // Ensure Event is available (browser context)
    if (typeof Event !== 'undefined') {
      formElement.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    }
  }
}

// End of contents from human-simulation.js


// Contents from fallback-strategies.js

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
    logFallbackEvent({ // logFallbackEvent will be defined below or needs to be hoisted/passed
        type: 'form-detection-failure',
        timestamp: Date.now(),
        details: context // Be careful about logging entire context if it's large or sensitive
    });

    if (context && typeof context.page !== 'undefined') {
        await invokeCaptchaSolver(context);

        let alternativeForms = [];
        if (isBrowserContext()) { // isBrowserContext will be defined below
            alternativeForms = queryAlternativeFormsDOM(); // queryAlternativeFormsDOM will be defined below
            for (const formEl of alternativeForms) {
                await simulateFallbackDomInteraction(formEl); // Updated to renamed function
            }
        } else if (isAutomationPage(context.page)) { // isAutomationPage will be defined below
            alternativeForms = await queryAlternativeFormsRemote(context.page); // queryAlternativeFormsRemote will be defined below
            for (const formMeta of alternativeForms) {
                await simulateAlternativeInteractionRemote(context.page, formMeta.index); // simulateAlternativeInteractionRemote will be defined below
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
 * Simulates human interaction with a form element in DOM context for fallback purposes.
 * @param {HTMLFormElement} formElement
 */
async function simulateFallbackDomInteraction(formElement) { // Renamed from simulateAlternativeInteraction
    try {
        if (!isBrowserContext() || !formElement || typeof formElement.querySelectorAll !== 'function') return;

        const inputs = formElement.querySelectorAll('input, textarea, select');
        for (let el of inputs) {
            if (typeof el.focus === 'function') el.focus();
            await delay(120 + Math.random() * 180); // delay is from human-simulation.js
            if (typeof el.blur === 'function') el.blur();
        }
        if (typeof formElement.submit === 'function') {
            formElement.submit();
        } else {
            // Ensure document and Event are available (browser context)
            if (typeof document !== 'undefined' && typeof Event !== 'undefined') {
                const evt = document.createEvent ? document.createEvent('Event') : null;
                if (evt) {
                    evt.initEvent('submit', true, true);
                    formElement.dispatchEvent(evt);
                } else {
                    formElement.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                }
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
async function simulateAlternativeInteractionRemote(page, index) { // This function is also potentially covered by FormAutomator or human-simulation
    if (!isAutomationPage(page)) return;
    try {
        await page.evaluate(async (formIdx) => {
            // This internal delay function will be shadowed by the global one if not careful
            const internalDelay = ms => new Promise(res => setTimeout(res, ms));
            const formsList = Array.from(document.forms); // Renamed to avoid conflict with outer scope 'forms'
            const currentForm = formsList[formIdx]; // Renamed
            if (!currentForm) return;
            const formInputs = currentForm.querySelectorAll('input, textarea, select'); // Renamed
            for (let el of formInputs) {
                if (typeof el.focus === 'function') el.focus();
                await internalDelay(120 + Math.random() * 180);
                if (typeof el.blur === 'function') el.blur();
            }
            if (typeof currentForm.submit === 'function') {
                currentForm.submit();
            } else {
                 if (typeof document !== 'undefined' && typeof Event !== 'undefined') {
                    const evt = document.createEvent ? document.createEvent('Event') : null;
                    if (evt) {
                        evt.initEvent('submit', true, true);
                        currentForm.dispatchEvent(evt);
                    } else {
                        currentForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                    }
                }
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
        try {
            if (typeof process !== 'undefined' && process.stderr && typeof process.stderr.write === 'function') {
                process.stderr.write(`[Fallback][LOGGER-ERROR] ${err && err.message || String(err)}\n`);
            }
        } catch (e2) {
            // Silent, last resort
        }
    }
}


function isBrowserContext() {
    return (typeof window !== 'undefined') && (typeof document !== 'undefined') && (typeof document.querySelectorAll === 'function');
}


function isAutomationPage(page) {
    return !!(page && typeof page.evaluate === 'function');
}


function queryAlternativeFormsDOM() {
    if (!isBrowserContext() || !document.forms) return [];
    return Array.from(document.forms);
}

async function queryAlternativeFormsRemote(page) {
    if (!isAutomationPage(page)) return [];
    try {
        const formsData = await page.evaluate(() => // Renamed from 'forms'
            Array.from(document.forms || []).map((f, idx) => ({
                action: f.action || null,
                id: f.id || null,
                name: f.name || null,
                index: idx
            }))
        );
        return formsData;
    } catch (err) {
        logFallbackEvent({
            type: 'alternative-forms-query-remote-error',
            timestamp: Date.now(),
            error: err && err.message || String(err)
        });
        return [];
    }
}
// delay function is already defined in human-simulation.js, so not repeated here.

// End of contents from fallback-strategies.js


// Contents from batch-processor.js
// Requires: const { v4: uuidv4 } = require('uuid');
// Requires: const fs = require('fs');
// Requires: const path = require('path');
// Requires: const EventEmitter = require('events');
// These will be hoisted or added to the top of automation-core.js

const batches = new Map(); // Global for batch state in this consolidated file
const BATCH_STATE_FILE_PATH = './batch-state.json'; // Define path, path.resolve might need adjustment based on final file location

function persistBatchState() {
    try {
        // Ensure fs is available (should be required at the top of automation-core.js)
        fs.writeFileSync(BATCH_STATE_FILE_PATH, JSON.stringify([...batches.entries()]), 'utf-8');
    } catch (err) {
        console.error('Failed to persist batch state:', err);
    }
}

function loadBatchState() {
    // Ensure fs is available
    if (fs.existsSync(BATCH_STATE_FILE_PATH)) {
        try {
            const entries = JSON.parse(fs.readFileSync(BATCH_STATE_FILE_PATH, 'utf-8'));
            for (const [id, data] of entries) {
                batches.set(id, data);
            }
        } catch (err) {
            console.warn('Could not load batch state:', err);
        }
    }
}

// Call loadBatchState when this module part is loaded.
// Consider if this should be called explicitly by an init function.
// For now, it will load when automation-core.js is required.
loadBatchState();

class BatchEventEmitter extends EventEmitter {} // EventEmitter should be required at top
const batchEmitter = new BatchEventEmitter();

function scheduleBatchRun(profile, batchConfig) {
    const batchId = uuidv4(); // uuidv4 should be required/imported at top
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
    logBatchEvent(batchId, 'scheduled', { profile, batchConfig }); // logBatchEvent defined below
    return batchId;
}

async function executeBatch(profile, inputRows) {
    const batchEntry = [...batches.values()].find(
        b => b.profile === profile && b.status === 'scheduled'
    );
    if (!batchEntry) throw new Error(batchProcessorI18n('No scheduled batch for this profile.')); // Renamed i18n

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
            const result = await processFormForBatch(batchEntry.profile, row); // Renamed processForm
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
    const retryDelayMs = retryPolicy.retryDelayMs || 1000; // Renamed to avoid conflict with global delay
    const finalResults = [];
    const newFailures = [];
    for (const failure of failures) {
        let attempt = failure.attempt || 1;
        let lastError = failure.error;
        let succeeded = false;
        while (attempt <= maxAttempts && !succeeded) {
            try {
                await delay(retryDelayMs); // Uses global delay from human-simulation
                const result = await processFormForBatch(failure.profile, failure.row); // Renamed
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

async function processFormForBatch(profile, row) { // Renamed from processForm
    // This is a placeholder. Actual implementation would use FormAutomator or similar.
    // For now, it uses the global delay from human-simulation.
    if (Math.random() < 0.9) {
        await delay(120 + Math.random() * 80);
        return { profile, row, status: 'success' };
    } else {
        throw new Error(batchProcessorI18n('Simulated form submission error')); // Renamed i18n
    }
}

// Logging utility specific to batch processor
const BATCH_PROCESSOR_LOG_FILE_PATH = './batch-processor.log'; // Define path
function logBatchEvent(batchId, event, data) {
    try {
        // Ensure fs and path are available (should be required at top)
        const stamp = new Date().toISOString();
        const safeBatchId = batchId !== undefined && batchId !== null ? batchId : 'NA';
        const entry = `[${stamp}][Batch:${safeBatchId}][${event}] ${JSON.stringify(data)}\n`;
        fs.appendFileSync(BATCH_PROCESSOR_LOG_FILE_PATH, entry, 'utf8');
    } catch (err) {
        // console.error('Batch logging failed:', err);
    }
}

function batchProcessorI18n(key) { // Renamed from i18n to avoid conflict
    return key; // Placeholder
}

// End of contents from batch-processor.js


// Contents from session-manager.js
// Requires: const crypto = require('crypto');
// Requires: const fs = require('fs'); (already required)
// Requires: const path = require('path'); (already required)
// Requires: const os = require('os');
// These will be hoisted or added to the top of automation-core.js, crypto and os are new

const SESSIONS_FILE_PATH = './sessions.json.enc'; // Define path
const COOKIES_FILE_PATH = './cookies.json.enc';  // Define path

const LOCK_RETRY_INTERVAL_SM = 10; // Renamed to avoid conflict if another LOCK_RETRY_INTERVAL exists
const LOCK_TIMEOUT_SM = 3000;    // Renamed

const SESSION_LIFETIME_SM = 7 * 24 * 60 * 60 * 1000; // Renamed

// Encryption configuration specific to this session manager
// It's important that this SECRET_KEY is distinct from any JWT_SECRET if they serve different purposes
const SM_SECRET_KEY = process.env.FORM_MASTER_LOCAL_SESSKEY || crypto.createHash('sha256').update('default_local_session_secret', 'utf8').digest().slice(0, 32);

function smEncryptData(data) { // Renamed
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', SM_SECRET_KEY, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(data), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function smDecryptData(str) { // Renamed
  const buf = Buffer.from(str, 'base64');
  const iv = buf.slice(0, 16);
  const tag = buf.slice(16, 32);
  const enc = buf.slice(32);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', SM_SECRET_KEY, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(dec.toString('utf8'));
  } catch (e) {
    console.error("Decryption failed for session manager data:", e.message);
    return {};
  }
}

function smLockFile(file) { // Renamed
  const lock = file + '.lock';
  const start = Date.now();
  while (fs.existsSync(lock)) {
    if (Date.now() - start > LOCK_TIMEOUT_SM) {
      throw new Error(`Timeout waiting for file lock (SM): ${file}`);
    }
    // Atomics.wait requires Node.js context with SharedArrayBuffer.
    // This might not be available in all environments (e.g. some browser extension contexts).
    // Consider a simpler busy-wait or alternative for broader compatibility if needed.
    // For now, assuming Node.js context for this part.
    if (typeof Atomics !== 'undefined' && typeof SharedArrayBuffer !== 'undefined' && typeof Int32Array !== 'undefined') {
        try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_INTERVAL_SM);
        } catch (e) { /* Fallback for environments where Atomics.wait might fail e.g. during shutdown */ }
    } else {
        // Fallback busy wait for environments without Atomics or SharedArrayBuffer
        const waitTill = Date.now() + LOCK_RETRY_INTERVAL_SM;
        while(Date.now() < waitTill);
    }
  }
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); // process.pid is Node specific
    return () => { if (fs.existsSync(lock)) fs.unlinkSync(lock); };
  } catch (e) {
    throw new Error(`Unable to acquire file lock (SM): ${file}. Error: ${e.message}`);
  }
}

function smLoadEncryptedStorage(file, fallback) { // Renamed
  if (!fs.existsSync(file)) return fallback;
  let unlock;
  try {
    unlock = smLockFile(file);
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw) return fallback;
    return smDecryptData(raw) || fallback;
  } catch (e) {
    console.error(`Failed to load encrypted storage (SM) ${file}:`, e.message);
    return fallback;
  } finally {
    if (unlock) unlock();
  }
}

function smSaveEncryptedStorage(file, data) { // Renamed
  let unlock;
  try {
    unlock = smLockFile(file);
    fs.writeFileSync(file, smEncryptData(data), 'utf8');
  } catch (e) {
      console.error(`Failed to save encrypted storage (SM) ${file}:`, e.message);
  } finally {
    if (unlock) unlock();
  }
}

function smCleanupSessions(sessions) { // Renamed
  const now = Date.now();
  let changed = false;
  for (const sid of Object.keys(sessions)) {
    if (!sessions[sid] || (sessions[sid].createdAt && now - sessions[sid].createdAt > SESSION_LIFETIME_SM)) {
      delete sessions[sid];
      changed = true;
    }
  }
  return changed;
}
function smCleanupCookies(cookies, validSessionIds = []) { // Renamed
  let changed = false;
  for (const sid of Object.keys(cookies)) {
    if (!validSessionIds.includes(sid)) {
      delete cookies[sid];
      changed = true;
    }
  }
  return changed;
}

function smGenerateSessionId() { // Renamed
  return crypto.randomBytes(24).toString('hex');
}

function smCreateSession(userId) { // Renamed
  let sessions = smLoadEncryptedStorage(SESSIONS_FILE_PATH, {});
  const now = Date.now();
  const sessionId = smGenerateSessionId();
  sessions[sessionId] = {
    userId,
    sessionId,
    createdAt: now,
    lastActive: now,
    data: {},
  };
  smCleanupSessions(sessions);
  smSaveEncryptedStorage(SESSIONS_FILE_PATH, sessions);
  return sessionId;
}

function smGetSession(sessionId) { // Renamed
  let sessions = smLoadEncryptedStorage(SESSIONS_FILE_PATH, {});
  if (smCleanupSessions(sessions)) {
    smSaveEncryptedStorage(SESSIONS_FILE_PATH, sessions);
  }
  const session = sessions[sessionId];
  const now = Date.now();
  if (session && now - (session.createdAt || 0) <= SESSION_LIFETIME_SM) {
    session.lastActive = now;
    sessions[sessionId] = session; // Update lastActive time
    smSaveEncryptedStorage(SESSIONS_FILE_PATH, sessions); // Persist the update
    return { ...session };
  }
  if (sessionId && sessions[sessionId]) { // Expired or invalid
    delete sessions[sessionId];
    smSaveEncryptedStorage(SESSIONS_FILE_PATH, sessions);
  }
  return null;
}

function smPersistSession(sessionData) { // Renamed
  if (!sessionData || !sessionData.sessionId) return false;
  let sessions = smLoadEncryptedStorage(SESSIONS_FILE_PATH, {});
  smCleanupSessions(sessions);
  sessions[sessionData.sessionId] = {
    ...sessionData,
    lastActive: Date.now(),
  };
  smSaveEncryptedStorage(SESSIONS_FILE_PATH, sessions);
  return true;
}

function smRestoreCookies(sessionId) { // Renamed
  const cookies = smLoadEncryptedStorage(COOKIES_FILE_PATH, {});
  return (cookies[sessionId] && Array.isArray(cookies[sessionId])) ? [...cookies[sessionId]] : [];
}

function smPersistCookies(sessionId, cookiesArray) { // Renamed
  let cookies = smLoadEncryptedStorage(COOKIES_FILE_PATH, {});
  cookies[sessionId] = Array.isArray(cookiesArray) ? cookiesArray.slice() : [];
  const sessions = smLoadEncryptedStorage(SESSIONS_FILE_PATH, {});
  if (smCleanupCookies(cookies, Object.keys(sessions))) { // Ensure this doesn't fail if SESSIONS_FILE is empty/new
     // smSaveEncryptedStorage(COOKIES_FILE_PATH, cookies); // This line was duplicated
  }
  smSaveEncryptedStorage(COOKIES_FILE_PATH, cookies);
  return true;
}

function smEndSession(sessionId) { // Renamed
  let sessions = smLoadEncryptedStorage(SESSIONS_FILE_PATH, {});
  let cookies = smLoadEncryptedStorage(COOKIES_FILE_PATH, {});
  if (sessions[sessionId]) delete sessions[sessionId];
  if (cookies[sessionId]) delete cookies[sessionId];
  smCleanupSessions(sessions);
  smCleanupCookies(cookies, Object.keys(sessions));
  smSaveEncryptedStorage(SESSIONS_FILE_PATH, sessions);
  smSaveEncryptedStorage(COOKIES_FILE_PATH, cookies);
  return true;
}

function smCleanupAll() { // Renamed
  let sessions = smLoadEncryptedStorage(SESSIONS_FILE_PATH, {});
  let cookies = smLoadEncryptedStorage(COOKIES_FILE_PATH, {});
  const changedSessions = smCleanupSessions(sessions);
  const changedCookies = smCleanupCookies(cookies, Object.keys(sessions));
  if (changedSessions) smSaveEncryptedStorage(SESSIONS_FILE_PATH, sessions);
  if (changedCookies) smSaveEncryptedStorage(COOKIES_FILE_PATH, cookies);
}

// End of contents from session-manager.js


// Contents from node.js (FormAutomator, utilities, and duplicated helper classes)

// Duplicated Logger class (also in backend.js)
class CoreLogger { // Renamed to CoreLogger to avoid conflict if ever imported together
    constructor(logFile) {
        this.logFile = logFile || 'automation-core.log'; // Default log file for core
        // fs should be required at the top of automation-core.js
    }

    log(message) {
        const timestamp = new Date().toISOString();
        const entry = `[${timestamp}] ${message}\n`;
        fs.appendFileSync(this.logFile, entry, 'utf8');
    }
}

// Duplicated ConfigLoader class (also in backend.js)
class CoreConfigLoader { // Renamed
    constructor() {
        this.config = {};
        // fs and ini should be required at the top
    }

    loadINI(filePath) {
        const data = fs.readFileSync(filePath, 'utf-8');
        this.config = ini.parse(data); // ini should be required
        return this.config;
    }

    async loadXML(filePath) {
        const data = fs.readFileSync(filePath, 'utf-8');
        // xml2js should be required at the top
        return new Promise((resolve, reject) => {
            xml2js.parseString(data, (err, result) => {
                if (err) return reject(err);
                this.config = { ...this.config, ...result };
                resolve(this.config);
            });
        });
    }
}

// Duplicated Translator class (also in backend.js)
class CoreTranslator { // Renamed
    constructor(potFile) {
        this.potFile = potFile || 'messages.pot'; // Default pot file
        // gettextParser should be required at the top
        this.translations = this._loadPotProper(this.potFile);
    }

    _loadPotProper(filePath) { // Renamed to avoid conflict if Translator was global
        if (!fs.existsSync(filePath)) return {};
        const raw = fs.readFileSync(filePath);
        let catalog;
        try {
            catalog = gettextParser.po.parse(raw); // gettextParser should be required
        } catch (e) {
            return {};
        }
        const result = {};
        if (catalog.translations) {
            for (const ctx in catalog.translations) {
                for (const key in catalog.translations[ctx]) {
                    const trans = catalog.translations[ctx][key];
                    if (trans.msgid && trans.msgstr && trans.msgstr.length && trans.msgstr[0]) {
                        result[trans.msgid] = trans.msgstr[0];
                    }
                }
            }
        }
        return result;
    }

    t(key, ...args) { // Added ...args for formatting
        let translated = this.translations[key] || key;
        // util.format might be better here if args are used.
        // For simplicity, keeping basic replace, or assuming 'format' from 'util' is available.
         if (args.length > 0 && typeof format === 'function') { // format from util
            translated = format(translated, ...args);
        } else if (args.length > 0) {
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

function isSensitiveField(fieldName) {
    const sensitivePatterns = [
        /password/i, /passcode/i, /secret/i, /token/i, /auth/i,
        /ssn/i, /social/i, /credit/i, /card/i, /cvv/i, /cvc/i,
        /pin\b/i, /email/i, /phone/i, /\bmobile\b/i,
        /\bun\/,username/i, /user(name)?/i,
    ];
    return sensitivePatterns.some((pat) => pat.test(fieldName));
}

function redactFieldValue(fieldValue) {
    if (!fieldValue) return '';
    return '[REDACTED]';
}

class FormAutomator {
    constructor(options = {}) { // Added default for options
        // puppeteer should be required at the top
        this.logger = new CoreLogger(options.logFile);
        this.configLoader = new CoreConfigLoader(); // Using Core versions
        this.translator = new CoreTranslator(options.potFile); // Using Core versions
        this.browser = null;
    }

    async launchBrowser() {
        try {
            this.browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
            this.logger.log(this.translator.t('Browser launched'));
        } catch (e) {
            this.logger.log(this.translator.t('Browser launch failed: %s', e.message));
            throw e;
        }
    }

    async closeBrowser() {
        if (this.browser) {
            await this.browser.close();
            this.logger.log(this.translator.t('Browser closed'));
        }
    }

    async processCSVData(csvPath) {
        // csv (csv-parser) should be required at the top
        return new Promise((resolve, reject) => {
            const results = [];
            fs.createReadStream(csvPath)
                .pipe(csv())
                .on('data', (data) => results.push(data))
                .on('end', () => resolve(results))
                .on('error', (err) => reject(err));
        });
    }

    async detectAndFillForm(page, formData) {
        const forms = await page.$$('form');
        if (!forms.length) {
            this.logger.log(this.translator.t('No form found'));
            return false;
        }
        for (let form of forms) {
            const inputs = await form.$$('[name]');
            let filled = false;
            for (let input of inputs) {
                const name = await input.evaluate(el => el.name);
                if (formData[name]) {
                    await input.focus();
                    await input.click({ clickCount: 3 }); // To clear existing value
                    await input.type(String(formData[name]), { delay: 80 + Math.random() * 40 }); // Ensure string
                    filled = true;
                    if (isSensitiveField(name)) {
                        this.logger.log(this.translator.t('Filled field: %s (redacted)', name));
                    } else {
                        this.logger.log(this.translator.t('Filled field: %s value: %s', name, formData[name]));
                    }
                }
            }
            if (filled) {
                try {
                    await form.evaluate(f => f.submit());
                    this.logger.log(this.translator.t('Form submitted'));
                    return true;
                } catch (e) {
                    this.logger.log(this.translator.t('Form submission failed: %s', e.message));
                    return false;
                }
            }
        }
        this.logger.log(this.translator.t('No form fields matched data to fill.'));
        return false;
    }

    async automate(url, formData) {
        if (!this.browser) { // Ensure browser is launched if not already
            await this.launchBrowser();
        }
        if(!this.browser) { // If launch failed
            this.logger.log(this.translator.t('Browser not available for automation.'));
            return;
        }
        const page = await this.browser.newPage();
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            this.logger.log(this.translator.t('Navigated to: %s', url));
            const result = await this.detectAndFillForm(page, formData);
            if (result) {
                this.logger.log(this.translator.t('Automation attempt completed. Result: Success.'));
            } else {
                this.logger.log(this.translator.t('Automation attempt completed. Result: Failure (no form filled or submitted).'));
            }
        } catch (e) {
            this.logger.log(this.translator.t('Automation error: %s', e.message));
        } finally {
            await page.close();
            // Decide if browser should be closed after each automate call or managed externally
            // For now, let's keep it open for potential subsequent calls unless explicitly closed.
            // await this.closeBrowser();
        }
    }
}

// End of FormAutomator and related utilities from node.js

module.exports = {
  // Specific exports from form-detection-engine
  detectForms,
  detectFormsInShadowDOM,
  extractFormMetadata,
  suggestMappings,
  fallbackVisualDetection,

  // Exports from human-simulation.js
  addRandomization,
  simulateTyping,
  simulateMouseInteraction,
  simulateScrolling,
  simulateFormSubmission,

  // Exports from fallback-strategies.js
  initFallbackHandlers,
  handleFormDetectionFailure,
  invokeCaptchaSolver,
  logFallbackEvent,
  simulateFallbackDomInteraction,
  simulateAlternativeInteractionRemote,
  queryAlternativeFormsRemote,
  queryAlternativeFormsDOM,
  isBrowserContext,
  isAutomationPage,

  // Exports from batch-processor.js
  scheduleBatchRun,
  executeBatch,
  retryFailedSubmissions,
  trackBatchProgress,
  handleBatchCompletion,
  batchEmitter,
  logBatchEvent,
  batchProcessorI18n,

  // Exports from session-manager.js (prefixed with sm)
  smCreateSession,
  smGetSession,
  smRestoreCookies,
  smPersistSession,
  smPersistCookies,
  smEndSession,
  smCleanupAll,

  // Exports from FormAutomator and related utilities (originally from node.js)
  FormAutomator,
  isSensitiveField,
  redactFieldValue,
  CoreLogger,
  CoreConfigLoader,
  CoreTranslator
};
