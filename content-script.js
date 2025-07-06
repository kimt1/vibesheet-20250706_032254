function log(message, data) {
    try {
      if (data !== undefined) {
        console.log(`[FormMaster] ${message}`, data);
      } else {
        console.log(`[FormMaster] ${message}`);
      }
    } catch (e) {}
  }

  // 1. Initialize Content Script
  function initContentScript() {
    log('Initializing content script');
    listenForMessages();
    const forms = scanForForms();
    highlightDetectedForms(forms);
    loadUserMappings().then(mappings => {
      applyUserMappings(mappings, forms).then(() => {
        forms.forEach(form => interceptFormSubmission(form));
      });
    });
    loadSettings().then(settings => injectSimulationModules(settings));
  }

  // 2. Scan the DOM for forms
  function scanForForms() {
    const forms = Array.from(document.forms);
    log(`${forms.length} forms detected`, forms);
    return forms;
  }

  // 3. Visually highlight detected forms
  function highlightDetectedForms(forms) {
    forms.forEach(form => {
      form.setAttribute('data-formmaster-detected', 'true');
      form.style.outline = '2px solid #32a852';
      form.addEventListener('mouseenter', () => {
        form.style.outline = '3px solid #2196f3';
      });
      form.addEventListener('mouseleave', () => {
        form.style.outline = '2px solid #32a852';
      });
    });
  }

  // 4. Apply user mappings for autofilling or field customization
  async function applyUserMappings(mappings, forms) {
    if (!mappings) return;
    const fillPromises = [];
    for (const form of forms) {
      const formId = getFormIdentifier(form);
      const formMapping = mappings[formId];
      if (formMapping && formMapping.fields) {
        for (const [selector, value] of Object.entries(formMapping.fields)) {
          const el = form.querySelector(selector);
          if (el) {
            fillPromises.push(setElementValueSimulated(el, value));
          }
        }
      }
    }
    // Wait for all simulations (including simulated typing) to complete
    return Promise.all(fillPromises);
  }

  // 5. Intercept form submission to provide hooks for automations
  function interceptFormSubmission(formElement) {
    formElement.addEventListener('submit', function(evt) {
      log('Intercepted form submission', {form: getFormIdentifier(formElement)});
      // Optionally prevent default for automation
      if (window.FormMasterForceAutomation) {
        evt.preventDefault();
        communicateWithBackground({
          type: 'form-submitted',
          formId: getFormIdentifier(formElement),
          data: serializeForm(formElement)
        });
      }
    }, true);
  }

  // 6. Message passing to background
  function communicateWithBackground(message) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage(message);
      } else if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.sendMessage) {
        browser.runtime.sendMessage(message);
      }
    } catch (e) {
      // silent fail
    }
  }

  // Listen for messages from background or popup
  function listenForMessages() {
    if (window.hasFormMasterListener) return;
    window.hasFormMasterListener = true;
    async function handler(message, sender, sendResponse) {
      if (message && message.type === 'fill-form') {
        const forms = scanForForms();
        await applyUserMappings(message.mappings, forms);
        sendResponse && sendResponse({status: 'filled'});
      }
      if (message && message.type === 'highlight-forms') {
        highlightDetectedForms(scanForForms());
        sendResponse && sendResponse({status: 'highlighted'});
      }
      // Support async response in Firefox
      return true;
    }
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(handler);
    } else if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.onMessage) {
      browser.runtime.onMessage.addListener(handler);
    }
  }

  // 7. Inject advanced simulation modules (e.g., for human-like typing, anti-detection)
  function injectSimulationModules(settings) {
    if (!settings || !settings.simulation) return;
    if (settings.simulation.humanlikeTyping) {
      Array.from(document.forms).forEach(form => {
        Array.from(form.elements).forEach(el => {
          el.addEventListener('input', function(e) {
            el.dataset.formmasterTyped = 'true';
          }, {once:true});
        });
      });
    }
    if (settings.simulation.mouseEvents) {
      document.body.addEventListener('mousedown', () => {}, true);
    }
    // Add more simulation hooks/strategies as needed
  }

  // Utilities

  function wrapChromeStorageGet(namespaceKey) {
    // Support both chrome.storage and browser.storage and fallback
    return new Promise(resolve => {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
          chrome.storage.sync.get([namespaceKey], result => resolve(result[namespaceKey] || {}));
        } else if (typeof browser !== 'undefined' && browser.storage && browser.storage.sync) {
          browser.storage.sync.get([namespaceKey]).then(result => resolve(result[namespaceKey] || {})).catch(() => resolve({}));
        } else {
          resolve({});
        }
      } catch (e) {
        // Try browser
        try {
          if (typeof browser !== 'undefined' && browser.storage && browser.storage.sync) {
            browser.storage.sync.get([namespaceKey]).then(result => resolve(result[namespaceKey] || {})).catch(() => resolve({}));
          } else {
            resolve({});
          }
        } catch (ee) {
          resolve({});
        }
      }
    });
  }

  function loadUserMappings() {
    return wrapChromeStorageGet('formMappings');
  }

  function loadSettings() {
    return wrapChromeStorageGet('formMasterSettings');
  }

  function getFormIdentifier(form) {
    return form.getAttribute('id') ||
           form.getAttribute('name') ||
           form.action ||
           `form-index-${Array.from(document.forms).indexOf(form)}`;
  }

  // Returns a Promise that resolves when the value is set, including simulated typing effect
  function setElementValueSimulated(el, value) {
    return new Promise((resolve) => {
      if (el.disabled || el.readOnly) return resolve();
      if (el.type === 'checkbox' || el.type === 'radio') {
        el.checked = !!value;
        el.dispatchEvent(new Event('change', {bubbles:true}));
        resolve();
      } else if (el.tagName === 'SELECT') {
        el.value = value;
        el.dispatchEvent(new Event('change', {bubbles:true}));
        resolve();
      } else {
        el.focus();
        el.value = '';
        let chars = String(value).split('');
        let i = 0;
        (function typeChar() {
          if (i < chars.length) {
            el.value += chars[i++];
            el.dispatchEvent(new Event('input', {bubbles:true}));
            setTimeout(typeChar, 15 + Math.random()*35);
          } else {
            el.dispatchEvent(new Event('change', {bubbles:true}));
            resolve();
          }
        })();
      }
    });
  }

  function serializeForm(form) {
    const elements = Array.from(form.elements)
      .filter(el => el.name && !el.disabled);
    return elements.reduce((acc, el) => {
      if (el.type === 'checkbox') {
        acc[el.name] = el.checked;
      } else if (el.type === 'radio') {
        if (el.checked) acc[el.name] = el.value;
      } else if (el.tagName === 'SELECT' && el.multiple) {
        acc[el.name] = Array.from(el.selectedOptions).map(o=>o.value);
      } else {
        acc[el.name] = el.value;
      }
      return acc;
    }, {});
  }

  // Entry Point
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initContentScript, {once:true});
  } else {
    initContentScript();
  }

})();