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
    field.dispatchEvent(new InputEvent('input', {bubbles: true}));

    if (opts.typing.errorRate > 0 && Math.random() < opts.typing.errorRate) {
      // Simulate mistyping a random character
      const errorChar = String.fromCharCode(97 + Math.floor(Math.random() * 26));
      field.value = text + errorChar;
      field.dispatchEvent(new InputEvent('input', {bubbles: true}));
      await delay(randomBetween(...opts.typing.correctionDelay));
      field.value = text;
      field.dispatchEvent(new InputEvent('input', {bubbles: true}));
    }

    await delay(randomBetween(opts.typing.minDelay, opts.typing.maxDelay));
  }
  field.dispatchEvent(new Event('change', {bubbles: true}));
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
    element.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: stepX, clientY: stepY, buttons: 0
    }));
    await delay(randomBetween(...opts.mouse.moveDelay));
  }

  if (action === 'click' || action === 'doubleClick') {
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
  let target = 0;
  let isWindow = false;
  if (element === window || element === document.body || !element) {
    element = window;
    isWindow = true;
    target = document.body.scrollHeight - window.innerHeight - randomBetween(0, opts.scroll.scrollJitter);
  } else {
    target = element.scrollHeight - element.clientHeight - randomBetween(0, opts.scroll.scrollJitter);
  }
  const scrollSteps = Math.max(8, Math.floor(Math.abs(target) / 80));
  for (let i = 0; i <= scrollSteps; i++) {
    const progress = i / scrollSteps;
    const curr = Math.floor(progress * target + randomBetween(-opts.scroll.scrollJitter, opts.scroll.scrollJitter));
    if (isWindow) {
      window.scrollTo(0, curr);
    } else {
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
    formElement.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
  }
}

module.exports = {
  addRandomization,
  simulateTyping,
  simulateMouseInteraction,
  simulateScrolling,
  simulateFormSubmission
};