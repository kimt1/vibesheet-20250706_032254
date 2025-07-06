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
  const walker = rootNode.createTreeWalker
    ? rootNode.createTreeWalker(
        rootNode,
        NodeFilter.SHOW_ELEMENT,
        null,
      )
    : null;
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
    // Generate unique set automatically at the end
  } while (walker.nextNode());
  return forms;
}

// Extract metadata about the form's structure, fields, labels etc.
function extractFormMetadata(formElement) {
  const fields = [];
  const usedFields = new Set();
  // Use form.elements, but filter out hidden/disabled (some browsers may include non-interactive)
  Array.from(formElement.elements || []).forEach((el) => {
    if (!el.name && !el.id) return;
    if (isHidden(el)) return;
    if (el.disabled) return;
    if (usedFields.has(el)) return;
    usedFields.add(el);
    let label = '';
    // Prefer label via <label for>
    if (el.id) {
      const labelElem = formElement.ownerDocument.querySelector(`label[for="${el.id}"]`);
      if (labelElem) label = labelElem.textContent.trim();
    }
    // Or parent <label>
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
      node: el,
    });
  });
  return {
    node: formElement,
    id: formElement.id || '',
    name: formElement.name || '',
    action: formElement.action || '',
    method: (formElement.method || '').toUpperCase(),
    fields,
  };
}

// Suggest mappings from rules or heuristics (e.g., autofill for "email", "password", etc.)
function suggestMappings(formFields, rules) {
  const suggestions = [];
  formFields.forEach((field) => {
    let bestMatch = null;
    if (rules && Array.isArray(rules)) {
      for (const rule of rules) {
        // Rule: { fieldMatch: RegExp|Function, typeMatch: String|Array, suggest: String }
        const matches =
          ((rule.fieldMatch && (typeof rule.fieldMatch === 'function'
            ? rule.fieldMatch(field)
            : (field.name && rule.fieldMatch.test(field.name)) ||
              (field.id && rule.fieldMatch.test(field.id)) ||
              (field.label && rule.fieldMatch.test(field.label))
          ))) &&
          (!rule.typeMatch ||
            (Array.isArray(rule.typeMatch)
              ? rule.typeMatch.includes(field.type)
              : field.type === rule.typeMatch));
        if (matches) {
          bestMatch = rule.suggest;
          break;
        }
      }
    }
    if (bestMatch) {
      suggestions.push({ field, mapping: bestMatch });
    } else {
      suggestions.push({ field, mapping: null });
    }
  });
  return suggestions;
}

// Visual fallback: parse a DOM snapshot for potential form controls visually grouped
function fallbackVisualDetection(domSnapshot) {
  // domSnapshot: Document or Node snapshot (assume Document or ShadowRoot)
  // Heuristics:
  //  - group input/select/textarea arranged closely
  //  - check proximity, visual alignment, similar y-axis, etc.
  //  - group as a 'synthetic' form
  // This is a best-effort for forms not wrapped in <form>
  const controls = [];
  FORM_FIELD_SELECTORS.forEach(sel => {
    controls.push(...Array.from(domSnapshot.querySelectorAll(sel)));
  });
  // Filter only visible/interactive controls
  const visibleControls = controls.filter(
    (el) => !isHidden(el) && !el.disabled
  );
  if (visibleControls.length === 0) return [];
  // Cluster controls by vertical position, allow max gap of 50px
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
  // Build metadata for each cluster-form
  return clusterForms.map((clusterEls, idx) => {
    const fields = clusterEls.map((el) => ({
      name: el.name || '',
      id: el.id || '',
      type: (el.type || el.tagName).toLowerCase(),
      label: '', // Try to get label
      placeholder: el.placeholder || '',
      required: !!el.required,
      autocomplete: el.autocomplete || '',
      node: el,
    }));
    return {
      node: null, // Not a true <form>
      id: '',
      name: '',
      action: '',
      method: '',
      synthetic: true,
      fields,
    };
  });
}

module.exports = {
  detectForms,
  detectFormsInShadowDOM,
  extractFormMetadata,
  suggestMappings,
  fallbackVisualDetection,
};