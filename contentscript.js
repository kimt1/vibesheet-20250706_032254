function log() {
  try { 
    console.log('[FormMaster]', ...arguments); 
  } catch (_) {}
}

function sendMessageToBackground(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, resolve);
    } catch (e) {
      log('Background message failed', e);
      resolve(null);
    }
  });
}

// Debounce version for async functions: prevents overlapping executions
function debounceAsync(fn, delay = 300) {
  let t = null;
  let pending = false;
  let lastArgs = null;
  let lastThis = null;

  async function runner() {
    if (pending) return;
    pending = true;
    await fn.apply(lastThis, lastArgs);
    pending = false;
  }

  return function(...args) {
    lastArgs = args;
    lastThis = this;
    clearTimeout(t);
    t = setTimeout(runner, delay);
  };
}

// FORM SCANNING

function scanForForms() {
  // Select all forms not injected by our script
  const forms = Array.from(document.forms).filter(form => 
    !form.hasAttribute('data-form-master-highlighted')
  );
  log('Scanned, found forms:', forms.length);
  return forms;
}

// FORM HIGHLIGHTING

function highlightDetectedForms(forms) {
  forms.forEach((form, i) => {
    form.setAttribute('data-form-master-highlighted', 'true');
    form.style.outline = '2px dashed #2d88ff';
    form.style.outlineOffset = '2px';
    form.dataset.fmOriginalOutline = form.style.outline;
  });

  // Remove highlighting after 2.5s
  setTimeout(() => {
    forms.forEach(form => {
      form.style.outline = form.dataset.fmOriginalOutline || '';
      form.removeAttribute('data-form-master-highlighted');
      delete form.dataset.fmOriginalOutline;
    });
  }, 2500);
}

// USER MAPPINGS APPLICATION

async function applyUserMappings(form, mappings) {
  if (!mappings || !form) return;
  Object.entries(mappings).forEach(([selector, value]) => {
    const el = form.querySelector(selector);
    if (el) {
      // Attempt to properly simulate native typing
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
}

// FORM SUBMISSION INTERCEPTION

function interceptFormSubmission(formElement, onIntercept) {
  if (!formElement) return;
  if (formElement.hasAttribute('data-fm-intercepted')) return;
  formElement.setAttribute('data-fm-intercepted', 'true');

  const handler = (event) => {
    event.preventDefault();
    log('FormMaster intercepted form submission');
    if (typeof onIntercept === 'function') onIntercept(formElement, event);
  };
  formElement.addEventListener('submit', handler, true);
}

// SIMULATION MODULES INJECTION

function injectSimulationModules(settings = {}) {
  // Input simulation module
  function simulateTyping(element, value, delay = 30) {
    let i = 0;
    element.value = '';
    function typeNext() {
      if (i < value.length) {
        element.value += value.charAt(i);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        i++;
        setTimeout(typeNext, delay);
      } else {
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    typeNext();
  }

  // Expose for other modules
  window.FormMasterSim = { simulateTyping };
}

// Utility: Return a unique selector for an element (approx)
function getUniqueSelector(el) {
  if (el.id) return `#${el.id}`;
  let path = el.tagName.toLowerCase();
  if (el.name) path += `[name="${el.name}"]`;
  let parent = el.parentElement;
  while (parent && parent !== document.body) {
    path = `${parent.tagName.toLowerCase()} > ${path}`;
    parent = parent.parentElement;
  }
  return path;
}

// MAIN INIT

async function initContentScript() {
  injectSimulationModules();

  const debouncedScan = debounceAsync(async () => {
    const forms = scanForForms();
    if (forms.length) highlightDetectedForms(forms);

    // Communicate form structures to background for mapping, user training, etc.
    for (let form of forms) {
      const formData = Array.from(form.elements).map(inp => ({
        name: inp.name,
        type: inp.type,
        tag: inp.tagName,
        selector: getUniqueSelector(inp)
      }));
      await sendMessageToBackground({ 
        type: 'form-detected', 
        url: location.href,
        structure: formData 
      });
    }

    // Retrieve and apply user-specific mappings (if any)
    const { mappings = {} } = (await sendMessageToBackground({ 
      type: 'get-mappings', url: location.href 
    })) || {};

    forms.forEach((form) => {
      // Only process if a mapping block is defined for this form
      if (Object.keys(mappings).length) {
        applyUserMappings(form, mappings);
      }
      interceptFormSubmission(form, async (formEl, event) => {
        // Optionally send the form data to background for automation logic
        const formPayload = new FormData(formEl);
        const plainData = {};
        for (let [k, v] of formPayload) plainData[k] = v;
        await sendMessageToBackground({ 
          type: 'form-submit-intercepted', 
          url: location.href,
          data: plainData
        });
      });
    });
  }, 250);

  // Observe DOM mutations
  const observer = new MutationObserver(debouncedScan);
  observer.observe(document.documentElement, {childList:true, subtree:true});
  // Initial scan
  debouncedScan();
}

// Entry
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  initContentScript();
} else {
  document.addEventListener('DOMContentLoaded', initContentScript);
}