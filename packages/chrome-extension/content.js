/**
 * Funny UI Annotator - Content Script
 *
 * Injects an overlay system into any webpage that lets users:
 * 1. Hover over elements to see highlights with element names
 * 2. Click to select and annotate elements
 * 3. Add comments with intent/severity
 * 4. Send all annotations to Funny via the background worker
 *
 * Uses Shadow DOM to isolate styles from the host page.
 */

(function () {
  'use strict';

  // Prevent double-injection
  if (window.__funnyAnnotatorActive) return;
  window.__funnyAnnotatorActive = true;

  console.log('[Funny Annotator] v2.1 loaded', new Date().toISOString());

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let isActive = false;
  let annotations = [];
  let annotationCounter = 0;
  let hoveredElement = null;
  let isPaused = false;
  let isBrowsing = false;
  let annotationsVisible = true;
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };
  let scrollRafId = null;
  let runtimeDisconnected = false;

  // Cache for component name lookups (WeakMap so GC can collect removed elements)
  const componentNameCache = new WeakMap();
  const componentTreeCache = new WeakMap();

  // DOM refs (created once, reused)
  let shadowHost = null;
  let shadowRoot = null;
  let toolbar = null;
  let hoverHighlight = null;
  let hoverLabel = null;
  let popover = null;
  let settingsPanel = null;
  let badgeContainer = null;
  let highlightContainer = null;

  // Cached popover element refs (set after createPopover)
  let popoverTextarea = null;
  let popoverError = null;
  let popoverElementName = null;
  let popoverAddBtn = null;
  let popoverDeleteBtn = null;

  // Drag listener refs (for cleanup)
  let dragMoveHandler = null;
  let dragUpHandler = null;

  // ---------------------------------------------------------------------------
  // Shadow DOM setup
  // ---------------------------------------------------------------------------
  async function createShadowHost() {
    shadowHost = document.createElement('div');
    shadowHost.id = 'funny-annotator-host';
    shadowHost.style.cssText = 'all:initial; position:fixed; top:0; left:0; width:0; height:0; z-index:2147483647; pointer-events:none;';
    document.documentElement.appendChild(shadowHost);
    shadowRoot = shadowHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = await loadStyles();
    shadowRoot.appendChild(style);

    // Containers
    highlightContainer = createElement('div', 'highlight-container');
    badgeContainer = createElement('div', 'badge-container');
    shadowRoot.appendChild(highlightContainer);
    shadowRoot.appendChild(badgeContainer);

    // Hover highlight
    hoverHighlight = createElement('div', 'hover-highlight');
    hoverLabel = createElement('div', 'hover-label');
    hoverHighlight.appendChild(hoverLabel);
    shadowRoot.appendChild(hoverHighlight);

    // Popover (hidden by default)
    popover = createPopover();
    shadowRoot.appendChild(popover);

    // Settings panel (hidden by default, positioned above toolbar)
    settingsPanel = createSettingsPanel();
    shadowRoot.appendChild(settingsPanel);

    // Toolbar
    toolbar = createToolbar();
    shadowRoot.appendChild(toolbar);
  }

  function createElement(tag, className) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    return el;
  }

  // ---------------------------------------------------------------------------
  // Element info extraction
  // ---------------------------------------------------------------------------
  function getElementName(el) {
    // Try framework component name first (React, Vue, Angular, Svelte)
    const compName = getComponentName(el);
    if (compName) return compName;

    // Fallback: tag + class or id
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    if (el.className && typeof el.className === 'string') {
      const cls = el.className.split(/\s+/).filter(c => c && !c.startsWith('funny-')).slice(0, 2).join('.');
      if (cls) return `${tag}.${cls}`;
    }
    // Aria / role
    const role = el.getAttribute('role');
    if (role) return `${tag}[role="${role}"]`;
    // Use text content for small elements
    const text = el.textContent?.trim();
    if (text && text.length < 30 && text.length > 0) return `${tag} "${text.slice(0, 20)}"`;
    return tag;
  }

  // Framework component access via page-bridge.js (MAIN world).
  // Content scripts can't see framework internals directly (isolated world).
  // We communicate with page-bridge.js via CustomEvents + DOM attributes.
  // Results are cached per-element in WeakMaps to avoid repeated DOM events.

  function queryComponentInfo(el) {
    // Single bridge call that populates both caches
    if (componentNameCache.has(el)) return;
    try {
      const uid = '__funny_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      el.setAttribute(uid, '');
      document.documentElement.setAttribute('data-funny-target', uid);
      document.dispatchEvent(new Event('__funny_get_component_info'));
      componentNameCache.set(el, el.getAttribute('data-funny-component') || '');
      componentTreeCache.set(el, el.getAttribute('data-funny-tree') || '');
      el.removeAttribute(uid);
      el.removeAttribute('data-funny-component');
      el.removeAttribute('data-funny-tree');
      document.documentElement.removeAttribute('data-funny-target');
    } catch (_) {
      componentNameCache.set(el, '');
      componentTreeCache.set(el, '');
    }
  }

  function getComponentName(el) {
    queryComponentInfo(el);
    return componentNameCache.get(el) || null;
  }

  function getComponentTree(el) {
    queryComponentInfo(el);
    return componentTreeCache.get(el) || '';
  }

  function getCSSSelector(el) {
    const parts = [];
    let current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        selector += `#${current.id}`;
        parts.unshift(selector);
        break;
      }
      if (current.className && typeof current.className === 'string') {
        const classes = current.className.trim().split(/\s+/).filter(c => c && !c.startsWith('funny-')).slice(0, 2);
        if (classes.length) selector += `.${classes.join('.')}`;
      }
      // Add nth-of-type if needed for disambiguation
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          selector += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(selector);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function getComputedStylesSummary(el) {
    const cs = window.getComputedStyle(el);
    const props = [
      'display', 'position', 'width', 'height',
      'margin', 'padding',
      'font-family', 'font-size', 'font-weight', 'line-height',
      'color', 'background-color',
      'border', 'border-radius',
      'opacity', 'overflow',
      'flex-direction', 'justify-content', 'align-items', 'gap'
    ];
    return props
      .map(p => {
        const v = cs.getPropertyValue(p);
        if (!v || v === 'none' || v === 'normal' || v === 'auto' || v === '0px' || v === 'rgba(0, 0, 0, 0)') return null;
        return `${p}: ${v}`;
      })
      .filter(Boolean)
      .join('; ');
  }

  function getAccessibilityInfo(el) {
    const info = [];
    const role = el.getAttribute('role');
    if (role) info.push(`role="${role}"`);
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) info.push(`aria-label="${ariaLabel}"`);
    const ariaDescribedby = el.getAttribute('aria-describedby');
    if (ariaDescribedby) info.push(`aria-describedby="${ariaDescribedby}"`);
    const tabindex = el.getAttribute('tabindex');
    if (tabindex) info.push(`tabindex="${tabindex}"`);
    const alt = el.getAttribute('alt');
    if (alt) info.push(`alt="${alt}"`);
    return info.join(', ') || 'none';
  }

  function getNearbyText(el) {
    const texts = [];
    const prev = el.previousElementSibling;
    if (prev?.textContent?.trim()) texts.push(prev.textContent.trim().slice(0, 40));
    const own = el.textContent?.trim();
    if (own) texts.push(own.slice(0, 60));
    const next = el.nextElementSibling;
    if (next?.textContent?.trim()) texts.push(next.textContent.trim().slice(0, 40));
    return texts.join(' | ') || 'none';
  }

  function getFullPath(el) {
    const parts = [];
    let current = el;
    while (current && current !== document.documentElement) {
      parts.unshift(current.tagName.toLowerCase());
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function getNearbyElements(el) {
    const items = [];
    const prev = el.previousElementSibling;
    if (prev) items.push(`prev: ${prev.tagName.toLowerCase()}${prev.className && typeof prev.className === 'string' ? '.' + prev.className.split(/\s+/)[0] : ''}`);
    const next = el.nextElementSibling;
    if (next) items.push(`next: ${next.tagName.toLowerCase()}${next.className && typeof next.className === 'string' ? '.' + next.className.split(/\s+/)[0] : ''}`);
    const parent = el.parentElement;
    if (parent) items.push(`parent: ${parent.tagName.toLowerCase()}${parent.className && typeof parent.className === 'string' ? '.' + parent.className.split(/\s+/)[0] : ''} (${parent.children.length} children)`);
    return items.join(', ') || 'none';
  }

  // ---------------------------------------------------------------------------
  // Hover highlight
  // ---------------------------------------------------------------------------
  function showHoverHighlight(el) {
    if (!el || el === hoveredElement) return;
    hoveredElement = el;
    const rect = el.getBoundingClientRect();
    hoverHighlight.style.cssText = `
      position: fixed;
      top: ${rect.top}px;
      left: ${rect.left}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      display: block;
      pointer-events: none;
    `;
    hoverLabel.textContent = getElementName(el);
  }

  function hideHoverHighlight() {
    hoveredElement = null;
    hoverHighlight.style.display = 'none';
  }

  // ---------------------------------------------------------------------------
  // Annotation highlights + badges (persistent, for annotated elements)
  // ---------------------------------------------------------------------------

  // Stored DOM refs for annotation overlays (avoid recreating on scroll)
  let annotationOverlays = []; // [{ hl, badge, element }]

  function renderAnnotations() {
    // Full rebuild: clears and recreates all overlays.
    // Called when annotations array changes (add/edit/delete/toggle visibility).
    annotationOverlays = [];
    highlightContainer.innerHTML = '';
    badgeContainer.innerHTML = '';

    if (!annotationsVisible) return;

    annotations.forEach((ann, i) => {
      const el = ann._element;
      if (!el || !document.contains(el)) return;
      const rect = el.getBoundingClientRect();

      // Persistent highlight (green dashed border)
      const hl = createElement('div', 'annotation-highlight');
      hl.style.cssText = `
        position: fixed;
        top: ${rect.top}px;
        left: ${rect.left}px;
        width: ${rect.width}px;
        height: ${rect.height}px;
        pointer-events: none;
      `;
      highlightContainer.appendChild(hl);

      // Badge
      const badge = createElement('div', 'annotation-badge');
      badge.textContent = String(i + 1);
      badge.style.cssText = `
        position: fixed;
        top: ${rect.top - 10}px;
        left: ${rect.right - 10}px;
        pointer-events: auto;
        cursor: pointer;
      `;
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        showPopoverForEdit(ann, i, e.clientX, e.clientY);
      });
      badgeContainer.appendChild(badge);

      annotationOverlays.push({ hl, badge, element: el });
    });
  }

  function repositionAnnotations() {
    // Fast path: move existing overlay DOM nodes without rebuilding.
    for (const { hl, badge, element } of annotationOverlays) {
      if (!document.contains(element)) continue;
      const rect = element.getBoundingClientRect();
      hl.style.top = `${rect.top}px`;
      hl.style.left = `${rect.left}px`;
      hl.style.width = `${rect.width}px`;
      hl.style.height = `${rect.height}px`;
      badge.style.top = `${rect.top - 10}px`;
      badge.style.left = `${rect.right - 10}px`;
    }
  }

  // Reposition on scroll/resize (throttled via rAF)
  function onScrollOrResize() {
    if (!isActive) return;
    if (scrollRafId) return; // already scheduled
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = null;
      // Move existing overlays (no DOM rebuild)
      repositionAnnotations();
      // Update hover highlight position
      if (hoveredElement && document.contains(hoveredElement)) {
        const rect = hoveredElement.getBoundingClientRect();
        hoverHighlight.style.top = `${rect.top}px`;
        hoverHighlight.style.left = `${rect.left}px`;
        hoverHighlight.style.width = `${rect.width}px`;
        hoverHighlight.style.height = `${rect.height}px`;
      }
      // Update popover position
      if (popover.style.display !== 'none' && pendingAnnotationElement && document.contains(pendingAnnotationElement)) {
        const r = pendingAnnotationElement.getBoundingClientRect();
        positionPopoverAtPoint(r.left, r.top);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Popover (annotation form)
  // ---------------------------------------------------------------------------
  function createPopover() {
    const pop = createElement('div', 'popover');
    pop.style.display = 'none';
    pop.innerHTML = `
      <div class="popover-header">
        <span class="popover-element-name"></span>
      </div>
      <textarea class="popover-textarea" placeholder="Describe the issue or change..." rows="3"></textarea>
      <div class="popover-error" style="display:none">Please describe the issue or change.</div>
      <div class="popover-details">
        <button class="popover-details-toggle">
          <svg class="popover-details-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
          Element info
        </button>
        <div class="popover-details-body" style="display:none">
          <div class="popover-detail-row"><span class="popover-detail-label">Selector</span><code class="popover-detail-value popover-detail-selector"></code></div>
          <div class="popover-detail-row"><span class="popover-detail-label">Classes</span><code class="popover-detail-value popover-detail-classes"></code></div>
          <div class="popover-detail-row popover-detail-component-row" style="display:none"><span class="popover-detail-label">Component</span><code class="popover-detail-value popover-detail-component"></code></div>
          <div class="popover-detail-section">
            <span class="popover-detail-label">Styles</span>
            <div class="popover-detail-styles"></div>
          </div>
          <div class="popover-detail-row popover-detail-a11y-row" style="display:none"><span class="popover-detail-label">Accessibility</span><span class="popover-detail-value popover-detail-a11y"></span></div>
        </div>
      </div>
      <div class="popover-actions">
        <button class="popover-delete" style="display:none">Delete</button>
        <div class="popover-actions-right">
          <button class="popover-cancel">Cancel</button>
          <button class="popover-add">Add</button>
        </div>
      </div>
    `;

    // Cache element refs
    popoverTextarea = pop.querySelector('.popover-textarea');
    popoverError = pop.querySelector('.popover-error');
    popoverElementName = pop.querySelector('.popover-element-name');
    popoverAddBtn = pop.querySelector('.popover-add');
    popoverDeleteBtn = pop.querySelector('.popover-delete');

    // Accordion toggle
    const detailsToggle = pop.querySelector('.popover-details-toggle');
    const detailsBody = pop.querySelector('.popover-details-body');
    const detailsArrow = pop.querySelector('.popover-details-arrow');
    detailsToggle.addEventListener('click', () => {
      const open = detailsBody.style.display !== 'none';
      detailsBody.style.display = open ? 'none' : 'block';
      detailsArrow.classList.toggle('popover-details-arrow-open', !open);
    });

    // Events
    pop.querySelector('.popover-cancel').addEventListener('click', () => hidePopover());
    popoverAddBtn.addEventListener('click', () => addAnnotationFromPopover());
    popoverDeleteBtn.addEventListener('click', () => deleteAnnotationFromPopover());

    // Clear validation error on input
    popoverTextarea.addEventListener('input', () => {
      if (popoverTextarea.value.trim()) {
        popoverTextarea.classList.remove('popover-textarea-error');
        popoverError.style.display = 'none';
      }
    });

    // Enter to submit
    popoverTextarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        addAnnotationFromPopover();
      }
    });

    return pop;
  }

  let pendingAnnotationElement = null;
  let editingAnnotationIndex = -1;

  function populateElementDetails(el) {
    const tag = el.tagName.toLowerCase();
    const classes = (typeof el.className === 'string' ? el.className : '').trim();
    const component = getComponentTree(el);
    const a11y = getAccessibilityInfo(el);

    // Selector
    popover.querySelector('.popover-detail-selector').textContent = tag + (el.id ? `#${el.id}` : '');

    // Classes
    const classesEl = popover.querySelector('.popover-detail-classes');
    classesEl.textContent = classes || 'none';

    // Component tree (only show if detected)
    const compRow = popover.querySelector('.popover-detail-component-row');
    if (component) {
      compRow.style.display = '';
      popover.querySelector('.popover-detail-component').textContent = component;
    } else {
      compRow.style.display = 'none';
    }

    // Computed styles as individual rows
    const stylesContainer = popover.querySelector('.popover-detail-styles');
    stylesContainer.innerHTML = '';
    const cs = window.getComputedStyle(el);
    const styleGroups = [
      { label: 'Layout', props: ['display', 'position', 'width', 'height', 'flex-direction', 'justify-content', 'align-items', 'gap'] },
      { label: 'Spacing', props: ['margin', 'padding'] },
      { label: 'Typography', props: ['font-family', 'font-size', 'font-weight', 'line-height', 'color'] },
      { label: 'Visual', props: ['background-color', 'border', 'border-radius', 'opacity', 'overflow'] },
    ];
    const skip = new Set(['none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)', 'visible', 'static']);
    for (const group of styleGroups) {
      const entries = [];
      for (const p of group.props) {
        const v = cs.getPropertyValue(p);
        if (!v || skip.has(v)) continue;
        entries.push({ prop: p, value: v });
      }
      if (entries.length === 0) continue;
      const groupEl = document.createElement('div');
      groupEl.className = 'popover-style-group';
      groupEl.innerHTML = `<span class="popover-style-group-label">${group.label}</span>`;
      for (const { prop, value } of entries) {
        const row = document.createElement('div');
        row.className = 'popover-style-row';
        row.innerHTML = `<span class="popover-style-prop">${prop}</span><span class="popover-style-val">${value}</span>`;
        groupEl.appendChild(row);
      }
      stylesContainer.appendChild(groupEl);
    }

    // Accessibility (only show if meaningful)
    const a11yRow = popover.querySelector('.popover-detail-a11y-row');
    if (a11y && a11y !== 'none') {
      a11yRow.style.display = '';
      popover.querySelector('.popover-detail-a11y').textContent = a11y;
    } else {
      a11yRow.style.display = 'none';
    }
  }

  function showPopoverForElement(el, clickX, clickY) {
    pendingAnnotationElement = el;
    editingAnnotationIndex = -1;

    popoverElementName.textContent = getElementName(el);
    popoverTextarea.value = '';
    popoverTextarea.classList.remove('popover-textarea-error');
    popoverError.style.display = 'none';
    popoverAddBtn.textContent = 'Add';
    popoverDeleteBtn.style.display = 'none';
    populateElementDetails(el);

    positionPopoverAtPoint(clickX, clickY);
    popover.style.display = 'block';
    popoverTextarea.focus();
  }

  function showPopoverForEdit(ann, index, clickX, clickY) {
    pendingAnnotationElement = ann._element;
    editingAnnotationIndex = index;

    popoverElementName.textContent = ann.elementName;
    popoverTextarea.value = ann.comment;
    popoverTextarea.classList.remove('popover-textarea-error');
    popoverError.style.display = 'none';
    popoverAddBtn.textContent = 'Update';
    popoverDeleteBtn.style.display = 'inline-block';
    populateElementDetails(ann._element);

    positionPopoverAtPoint(clickX, clickY);
    popover.style.display = 'block';
    popoverTextarea.focus();
  }

  function positionPopoverAtPoint(x, y) {
    const pw = 320;
    const ph = 260;
    // Position below and to the right of the click point
    let top = y + 12;
    let left = x + 12;

    // If it overflows bottom, place above the click
    if (top + ph > window.innerHeight) top = y - ph - 12;
    // If it overflows right, place to the left of the click
    if (left + pw > window.innerWidth) left = x - pw - 12;
    if (left < 8) left = 8;
    if (top < 8) top = 8;

    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
  }

  function hidePopover() {
    popover.style.display = 'none';
    pendingAnnotationElement = null;
    editingAnnotationIndex = -1;
    hideHoverHighlight();
  }

  function addAnnotationFromPopover() {
    const comment = popoverTextarea.value.trim();
    const el = pendingAnnotationElement;

    if (!el) return;

    // Validate: comment is required
    if (!comment) {
      popoverTextarea.classList.add('popover-textarea-error');
      popoverError.style.display = 'block';
      popoverTextarea.focus();
      return;
    }

    const rect = el.getBoundingClientRect();
    const annotationData = {
      // Required (Agentation schema v1)
      id: `ann_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      comment,
      elementPath: getCSSSelector(el),
      timestamp: Date.now(),
      x: Math.round((rect.left + rect.width / 2) / window.innerWidth * 100 * 10) / 10,
      y: Math.round(rect.top + window.scrollY),
      element: el.tagName.toLowerCase(),
      // Recommended
      url: window.location.href,
      boundingBox: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      // Optional context
      componentTree: getComponentTree(el),
      cssClasses: (typeof el.className === 'string' ? el.className : '').trim(),
      computedStyles: getComputedStylesSummary(el),
      accessibility: getAccessibilityInfo(el),
      nearbyText: getNearbyText(el),
      selectedText: window.getSelection()?.toString()?.trim() || '',
      // Browser component
      isFixed: ['fixed', 'sticky'].includes(window.getComputedStyle(el).position),
      fullPath: getFullPath(el),
      nearbyElements: getNearbyElements(el),
      // Lifecycle
      status: 'pending',
      // Extra (not in schema, useful for agents)
      elementName: getElementName(el),
      outerHTML: el.outerHTML.slice(0, 2000),
      _element: el // private ref, not serialized
    };

    if (editingAnnotationIndex >= 0) {
      annotations[editingAnnotationIndex] = annotationData;
    } else {
      annotationCounter++;
      annotations.push(annotationData);
    }

    hidePopover();
    renderAnnotations();
    updateToolbarCount();
  }

  function deleteAnnotationFromPopover() {
    if (editingAnnotationIndex >= 0) {
      annotations.splice(editingAnnotationIndex, 1);
    }
    hidePopover();
    renderAnnotations();
    updateToolbarCount();
  }

  // ---------------------------------------------------------------------------
  // Toolbar
  // ---------------------------------------------------------------------------
  function createToolbar() {
    const tb = createElement('div', 'toolbar');
    tb.innerHTML = `
      <div class="toolbar-drag-handle" title="Drag to move">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="8" cy="4" r="1.5"></circle>
          <circle cx="16" cy="4" r="1.5"></circle>
          <circle cx="8" cy="12" r="1.5"></circle>
          <circle cx="16" cy="12" r="1.5"></circle>
          <circle cx="8" cy="20" r="1.5"></circle>
          <circle cx="16" cy="20" r="1.5"></circle>
        </svg>
      </div>
      <button class="toolbar-btn" data-action="pause" title="Pause animations">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <rect x="9" y="8" width="2" height="8" fill="currentColor" stroke="none"></rect>
          <rect x="13" y="8" width="2" height="8" fill="currentColor" stroke="none"></rect>
        </svg>
      </button>
      <button class="toolbar-btn" data-action="browse" title="Browse mode — navigate the page">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M5 12h14"></path>
          <path d="M12 5l7 7-7 7"></path>
        </svg>
      </button>
      <button class="toolbar-btn" data-action="toggle-visibility" title="Toggle annotations">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
      </button>
      <button class="toolbar-btn" data-action="copy" title="Copy as markdown">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
      </button>
      <button class="toolbar-btn" data-action="clear" title="Clear all annotations">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
      <button class="toolbar-btn" data-action="settings" title="Settings">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      </button>
      <div class="toolbar-separator"></div>
      <button class="toolbar-btn toolbar-btn-send" data-action="send" title="Send to Funny">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="22" y1="2" x2="11" y2="13"></line>
          <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
        </svg>
        <span class="toolbar-send-label">Send to Funny</span>
        <span class="toolbar-count" style="display:none">0</span>
      </button>
      <button class="toolbar-btn" data-action="close" title="Close annotator">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    `;

    tb.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      e.stopPropagation();
      handleToolbarAction(btn.dataset.action);
    });

    // Drag to reposition (only from the drag handle)
    const dragHandle = tb.querySelector('.toolbar-drag-handle');
    dragHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isDragging = true;
      const rect = tb.getBoundingClientRect();
      dragOffset.x = e.clientX - rect.left;
      dragOffset.y = e.clientY - rect.top;
      tb.classList.add('toolbar-dragging');
      // Close panels so they don't detach visually
      hideSettingsPanel();
      hidePopover();
    });

    // Named handlers so they can be removed on deactivate
    dragMoveHandler = (e) => {
      if (!isDragging) return;
      const x = e.clientX - dragOffset.x;
      const y = e.clientY - dragOffset.y;
      tb.style.left = `${x}px`;
      tb.style.top = `${y}px`;
      tb.style.bottom = 'auto';
      tb.style.transform = 'none';
    };
    dragUpHandler = () => {
      if (!isDragging) return;
      isDragging = false;
      tb.classList.remove('toolbar-dragging');
    };

    return tb;
  }

  function updateToolbarCount() {
    const count = toolbar.querySelector('.toolbar-count');
    const label = toolbar.querySelector('.toolbar-send-label');
    if (annotations.length > 0) {
      count.textContent = String(annotations.length);
      count.style.display = 'inline-flex';
      label.textContent = `Send (${annotations.length})`;
    } else {
      count.style.display = 'none';
      label.textContent = 'Send to Funny';
    }
  }

  function handleToolbarAction(action) {
    switch (action) {
      case 'pause':
        togglePauseAnimations();
        break;
      case 'browse':
        toggleBrowseMode();
        break;
      case 'toggle-visibility':
        annotationsVisible = !annotationsVisible;
        renderAnnotations();
        updateVisibilityButton();
        break;
      case 'copy':
        copyAsMarkdown();
        break;
      case 'clear':
        annotations = [];
        annotationCounter = 0;
        renderAnnotations();
        updateToolbarCount();
        break;
      case 'settings':
        toggleSettingsPanel();
        break;
      case 'send':
        sendToFunny();
        break;
      case 'close':
        deactivate();
        break;
    }
  }

  function updateVisibilityButton() {
    const btn = toolbar.querySelector('[data-action="toggle-visibility"]');
    if (annotationsVisible) {
      btn.classList.remove('toolbar-btn-active');
      btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>`;
    } else {
      btn.classList.add('toolbar-btn-active');
      btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
          <line x1="1" y1="1" x2="23" y2="23"></line>
        </svg>`;
    }
  }

  function togglePauseAnimations() {
    isPaused = !isPaused;
    const btn = toolbar.querySelector('[data-action="pause"]');
    if (isPaused) {
      document.getAnimations().forEach(a => a.pause());
      btn.classList.add('toolbar-btn-active');
      btn.title = 'Resume animations';
      showToast('Animations paused — annotate the current frame');
    } else {
      document.getAnimations().forEach(a => a.play());
      btn.classList.remove('toolbar-btn-active');
      btn.title = 'Pause animations';
    }
  }

  function toggleBrowseMode() {
    isBrowsing = !isBrowsing;
    const btn = toolbar.querySelector('[data-action="browse"]');
    if (isBrowsing) {
      btn.classList.add('toolbar-btn-active');
      btn.title = 'Annotate mode — select elements';
      hideHoverHighlight();
      hidePopover();
    } else {
      btn.classList.remove('toolbar-btn-active');
      btn.title = 'Browse mode — navigate the page';
    }
  }

  // ---------------------------------------------------------------------------
  // Settings panel (inline, replaces popup)
  // ---------------------------------------------------------------------------
  function createSettingsPanel() {
    const panel = createElement('div', 'settings-panel');
    panel.style.display = 'none';
    panel.innerHTML = `
      <div class="settings-header">
        <div class="settings-title">
          <span class="settings-logo">F</span>
          <span>Settings</span>
          <span class="settings-dot" title="Not connected"></span>
        </div>
        <button class="settings-close-btn" title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      <div class="settings-body">
        <div class="settings-field">
          <label>Server URL</label>
          <div class="settings-url-row">
            <input type="text" class="settings-input" data-key="serverUrl" placeholder="http://localhost:3001" />
            <button class="settings-connect-btn" title="Connect">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M5 12h14"></path>
                <path d="M12 5l7 7-7 7"></path>
              </svg>
            </button>
          </div>
          <div class="settings-status"></div>
        </div>
        <div class="settings-field">
          <label>Project</label>
          <select class="settings-select" data-key="projectId">
            <option value="">Loading...</option>
          </select>
        </div>
        <div class="settings-field">
          <label>Provider</label>
          <select class="settings-select" data-key="provider">
            <option value="">Loading...</option>
          </select>
        </div>
        <div class="settings-row">
          <div class="settings-field">
            <label>Model</label>
            <select class="settings-select" data-key="model">
              <option value="">-</option>
            </select>
          </div>
          <div class="settings-field">
            <label>Mode</label>
            <select class="settings-select" data-key="mode">
              <option value="local">Local</option>
              <option value="worktree">Worktree</option>
            </select>
          </div>
        </div>
        <div class="settings-react-status"></div>
      </div>
    `;

    // Close button
    panel.querySelector('.settings-close-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      hideSettingsPanel();
    });

    // Connect button
    panel.querySelector('.settings-connect-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      testSettingsConnection();
    });

    // Auto-save on change
    panel.querySelectorAll('.settings-select, .settings-input').forEach(el => {
      el.addEventListener('change', (e) => {
        e.stopPropagation();
        // If provider changed, repopulate models
        if (el.dataset.key === 'provider') {
          populateSettingsModels(el.value);
        }
        saveSettings();
      });
    });

    // Prevent clicks inside panel from triggering annotation
    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.addEventListener('mousedown', (e) => e.stopPropagation());

    return panel;
  }

  // Cached provider data for the settings panel
  let settingsProviderData = null;

  function toggleSettingsPanel() {
    if (settingsPanel.style.display === 'block') {
      hideSettingsPanel();
    } else {
      showSettingsPanel();
    }
  }

  function showSettingsPanel() {
    settingsPanel.style.display = 'block';
    positionSettingsPanel();
    loadSettingsData();
    updateFrameworkStatus();
  }

  function detectFramework() {
    // Ask page-bridge.js (MAIN world) to detect JS frameworks.
    // Returns a comma-separated string like "React, Next.js" or "" if none found.
    try {
      document.documentElement.removeAttribute('data-funny-framework');
      document.dispatchEvent(new Event('__funny_detect_framework'));
      const result = document.documentElement.getAttribute('data-funny-framework') || '';
      console.log('[Funny Annotator] Framework detect result:', result || 'none');
      document.documentElement.removeAttribute('data-funny-framework');
      return result;
    } catch (_) {
      return '';
    }
  }

  function updateFrameworkStatus() {
    const el = settingsPanel.querySelector('.settings-react-status');
    const frameworks = detectFramework();
    if (frameworks) {
      el.style.display = 'none';
      el.innerHTML = '';
    } else {
      el.style.display = 'flex';
      el.className = 'settings-react-status settings-react-no';
      el.innerHTML = '<span class="settings-react-dot settings-react-dot-no"></span> No JS framework detected — component tree data will not be included in annotations';
    }
  }

  function hideSettingsPanel() {
    settingsPanel.style.display = 'none';
  }

  function positionSettingsPanel() {
    const settingsBtn = toolbar.querySelector('[data-action="settings"]');
    const btnRect = settingsBtn.getBoundingClientRect();
    const panelWidth = 340;
    const gap = 12;

    // Center panel horizontally on the settings button
    let left = btnRect.left + btnRect.width / 2 - panelWidth / 2;
    let top = btnRect.top - gap;

    // Keep within viewport
    if (left + panelWidth > window.innerWidth - 8) left = window.innerWidth - panelWidth - 8;
    if (left < 8) left = 8;

    // Show above by default; measure height after display
    settingsPanel.style.left = `${left}px`;
    settingsPanel.style.top = 'auto';
    settingsPanel.style.bottom = `${window.innerHeight - top}px`;
  }

  async function loadSettingsData() {
    const statusEl = settingsPanel.querySelector('.settings-status');
    statusEl.textContent = 'Loading...';
    statusEl.className = 'settings-status';

    try {
      const data = await new Promise((resolve) => {
        safeSendMessage({ type: 'GET_FULL_CONFIG' }, resolve);
      });

      if (!data?.success) {
        statusEl.textContent = data?.error || 'Failed to load config';
        statusEl.className = 'settings-status settings-status-error';
        return;
      }

      const config = data.config || {};

      // Populate server URL
      const serverInput = settingsPanel.querySelector('[data-key="serverUrl"]');
      serverInput.value = config.serverUrl || 'http://localhost:3001';

      // Populate mode
      const modeSelect = settingsPanel.querySelector('[data-key="mode"]');
      modeSelect.value = config.mode || 'local';

      // Populate projects
      const projectSelect = settingsPanel.querySelector('[data-key="projectId"]');
      projectSelect.innerHTML = '<option value="">Select a project...</option>';
      (data.projects || []).forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        if (p.id === config.projectId) opt.selected = true;
        projectSelect.appendChild(opt);
      });

      // Populate providers
      settingsProviderData = data.providers || {};
      const providerSelect = settingsPanel.querySelector('[data-key="provider"]');
      providerSelect.innerHTML = '';
      const available = Object.entries(settingsProviderData)
        .filter(([_, info]) => info.available);

      if (available.length === 0) {
        providerSelect.innerHTML = '<option value="">No providers</option>';
      } else {
        const effectiveProvider = (config.provider && settingsProviderData[config.provider]?.available)
          ? config.provider : available[0][0];
        available.forEach(([key, info]) => {
          const opt = document.createElement('option');
          opt.value = key;
          opt.textContent = info.label || key;
          if (key === effectiveProvider) opt.selected = true;
          providerSelect.appendChild(opt);
        });
        providerSelect.value = effectiveProvider;
        populateSettingsModels(effectiveProvider, config.model);
      }

      // Connection state (dot + connect button + status text)
      const dot = settingsPanel.querySelector('.settings-dot');
      const connectBtn = settingsPanel.querySelector('.settings-connect-btn');
      if (data.connected) {
        dot.className = 'settings-dot settings-dot-ok';
        dot.title = 'Connected';
        connectBtn.className = 'settings-connect-btn settings-connect-btn-ok';
        statusEl.textContent = 'Connected';
        statusEl.className = 'settings-status settings-status-ok';
      } else {
        dot.className = 'settings-dot settings-dot-err';
        dot.title = 'Not connected';
        connectBtn.className = 'settings-connect-btn settings-connect-btn-err';
        statusEl.textContent = 'Not connected — click arrow to connect';
        statusEl.className = 'settings-status settings-status-error';
      }
    } catch (err) {
      statusEl.textContent = 'Error loading settings';
      statusEl.className = 'settings-status settings-status-error';
    }
  }

  function populateSettingsModels(provider, selectedModel) {
    const modelSelect = settingsPanel.querySelector('[data-key="model"]');
    modelSelect.innerHTML = '';

    if (!settingsProviderData || !settingsProviderData[provider]) {
      modelSelect.innerHTML = '<option value="">-</option>';
      return;
    }

    const info = settingsProviderData[provider];
    const models = info.modelsWithLabels || info.models?.map(m => ({ value: m, label: m })) || [];
    const effectiveModel = (selectedModel && models.some(m => m.value === selectedModel))
      ? selectedModel
      : info.defaultModel || models[0]?.value || '';

    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.value;
      opt.textContent = m.label;
      if (m.value === effectiveModel) opt.selected = true;
      modelSelect.appendChild(opt);
    });

    modelSelect.value = effectiveModel;
  }

  function saveSettings() {
    const config = {};
    settingsPanel.querySelectorAll('[data-key]').forEach(el => {
      config[el.dataset.key] = el.value;
    });
    safeSendMessage({ type: 'SAVE_CONFIG', config });
  }

  async function testSettingsConnection() {
    const statusEl = settingsPanel.querySelector('.settings-status');
    const connectBtn = settingsPanel.querySelector('.settings-connect-btn');
    const serverUrl = settingsPanel.querySelector('[data-key="serverUrl"]').value.trim();
    statusEl.textContent = 'Connecting...';
    statusEl.className = 'settings-status';
    connectBtn.className = 'settings-connect-btn';

    try {
      const result = await new Promise((resolve) => {
        safeSendMessage({ type: 'TEST_CONNECTION', serverUrl }, resolve);
      });

      const dot = settingsPanel.querySelector('.settings-dot');
      if (result?.success) {
        dot.className = 'settings-dot settings-dot-ok';
        connectBtn.className = 'settings-connect-btn settings-connect-btn-ok';
        statusEl.textContent = 'Connected';
        statusEl.className = 'settings-status settings-status-ok';
        // Reload all data with new URL
        saveSettings();
        loadSettingsData();
      } else {
        dot.className = 'settings-dot settings-dot-err';
        connectBtn.className = 'settings-connect-btn settings-connect-btn-err';
        statusEl.textContent = result?.error || 'Connection failed';
        statusEl.className = 'settings-status settings-status-error';
      }
    } catch (_) {
      connectBtn.className = 'settings-connect-btn settings-connect-btn-err';
      statusEl.textContent = 'Connection failed';
      statusEl.className = 'settings-status settings-status-error';
    }
  }

  // ---------------------------------------------------------------------------
  // Generate markdown output
  // ---------------------------------------------------------------------------
  function generateMarkdown() {
    if (annotations.length === 0) return '';

    let md = `## UI Review: ${window.location.href}\n\n`;
    md += `**Page title:** ${document.title}\n`;
    md += `**Viewport:** ${window.innerWidth}x${window.innerHeight}\n`;
    md += `**Date:** ${new Date().toISOString()}\n\n---\n\n`;

    annotations.forEach((ann, i) => {
      md += `### Annotation ${i + 1}\n\n`;
      md += `**Element:** \`${ann.element}\` at \`${ann.elementPath}\`\n`;
      md += `**Position:** ${ann.x}% from left, ${ann.y}px from top\n`;
      if (ann.cssClasses) md += `**Classes:** \`${ann.cssClasses}\`\n`;
      if (ann.componentTree) md += `**Component Tree:** \`${ann.componentTree}\`\n`;
      md += `**Styles:** ${ann.computedStyles}\n`;
      md += `**Accessibility:** ${ann.accessibility}\n`;
      md += `**Nearby text:** ${ann.nearbyText}\n`;
      md += `**Bounding box:** ${ann.boundingBox.width}x${ann.boundingBox.height} at (${ann.boundingBox.x}, ${ann.boundingBox.y})\n`;
      if (ann.isFixed) md += `**Fixed position:** yes\n`;
      if (ann.comment) md += `\n**Comment:** ${ann.comment}\n`;
      md += `\n**HTML (truncated):**\n\`\`\`html\n${ann.outerHTML.slice(0, 500)}\n\`\`\`\n\n`;
      if (i < annotations.length - 1) md += `---\n\n`;
    });

    md += `\n---\n\nPlease analyze these UI annotations and provide:\n`;
    md += `1. CSS/styling fixes for each issue\n`;
    md += `2. Accessibility improvements if needed\n`;
    md += `3. Responsive design suggestions\n`;
    md += `4. Code changes with file paths and specific selectors\n`;

    return md;
  }

  function copyAsMarkdown() {
    const md = generateMarkdown();
    if (!md) return;
    navigator.clipboard.writeText(md).then(() => {
      showToast('Copied to clipboard');
    });
  }

  // ---------------------------------------------------------------------------
  // Send to Funny
  // ---------------------------------------------------------------------------
  async function sendToFunny() {
    if (annotations.length === 0) {
      showToast('No annotations to send');
      return;
    }

    const sendBtn = toolbar.querySelector('[data-action="send"]');
    sendBtn.classList.add('toolbar-btn-loading');
    sendBtn.setAttribute('disabled', 'true');

    try {
      // Take screenshot
      const screenshot = await captureScreenshot();

      // Serialize annotations (strip _element refs)
      const serialized = annotations.map(({ _element, ...rest }) => rest);

      // Send to background worker
      safeSendMessage({
        type: 'SEND_TO_FUNNY',
        data: {
          url: window.location.href,
          title: document.title,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          annotations: serialized,
          markdown: generateMarkdown(),
          screenshot
        }
      }, (response) => {
        sendBtn.classList.remove('toolbar-btn-loading');
        sendBtn.removeAttribute('disabled');

        if (response?.success) {
          showToast(`Sent to Funny! Thread created.`);
        } else {
          showToast(response?.error || 'Failed to send. Is Funny running?', true);
        }
      });
    } catch (err) {
      sendBtn.classList.remove('toolbar-btn-loading');
      sendBtn.removeAttribute('disabled');
      showToast(`Error: ${err.message}`, true);
    }
  }

  function captureScreenshot() {
    return new Promise((resolve) => {
      safeSendMessage({ type: 'CAPTURE_SCREENSHOT' }, (response) => {
        resolve(response?.screenshot || null);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------
  function showToast(message, isError = false) {
    const existing = shadowRoot.querySelector('.toast');
    if (existing) existing.remove();

    const toast = createElement('div', `toast ${isError ? 'toast-error' : ''}`);
    toast.textContent = message;
    shadowRoot.appendChild(toast);

    setTimeout(() => toast.classList.add('toast-visible'), 10);
    setTimeout(() => {
      toast.classList.remove('toast-visible');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------
  function onMouseMove(e) {
    if (!isActive || isBrowsing || popover.style.display === 'block') return;

    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === shadowHost || shadowHost.contains(el)) {
      hideHoverHighlight();
      return;
    }
    // Ignore tiny elements and document/html
    if (el === document.documentElement || el === document.body) {
      hideHoverHighlight();
      return;
    }
    showHoverHighlight(el);
  }

  function onClick(e) {
    if (!isActive) return;

    // Ignore clicks on our own UI (use composedPath to reliably cross shadow DOM boundaries)
    if (e.composedPath().includes(shadowHost)) return;

    // In browse mode, let clicks pass through to the page
    if (isBrowsing) return;

    // Close settings panel if open
    if (settingsPanel.style.display === 'block') {
      hideSettingsPanel();
      return;
    }

    // Ignore if popover is open
    if (popover.style.display === 'block') {
      hidePopover();
      return;
    }

    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === document.documentElement || el === document.body) return;

    e.preventDefault();
    e.stopPropagation();

    // Keep the hover highlight visible while the popover is open
    showPopoverForElement(el, e.clientX, e.clientY);
  }

  function onKeyDown(e) {
    if (!isActive) return;
    if (e.key === 'Escape') {
      if (settingsPanel.style.display === 'block') {
        hideSettingsPanel();
      } else if (popover.style.display === 'block') {
        hidePopover();
      } else {
        deactivate();
      }
      e.preventDefault();
    }
  }

  // ---------------------------------------------------------------------------
  // Activate / Deactivate
  // ---------------------------------------------------------------------------
  async function activate() {
    if (isActive) return;
    isActive = true;
    if (!shadowHost) await createShadowHost();
    toolbar.style.display = 'flex';

    // Inject page-bridge.js into MAIN world (for framework detection).
    // Done via background script to bypass CSP restrictions.
    if (!window.__funnyBridgeInjected) {
      safeSendMessage({ type: 'INJECT_PAGE_BRIDGE' }, () => {
        window.__funnyBridgeInjected = true;
      });
    }

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize, true);
    // Drag listeners (registered on activate, removed on deactivate)
    document.addEventListener('mousemove', dragMoveHandler);
    document.addEventListener('mouseup', dragUpHandler);

    renderAnnotations();
    updateToolbarCount();
  }

  function deactivate() {
    isActive = false;
    hideHoverHighlight();
    hidePopover();
    hideSettingsPanel();
    toolbar.style.display = 'none';
    highlightContainer.innerHTML = '';
    badgeContainer.innerHTML = '';
    annotationOverlays = [];

    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onScrollOrResize, true);
    document.removeEventListener('mousemove', dragMoveHandler);
    document.removeEventListener('mouseup', dragUpHandler);

    // Cancel any pending rAF
    if (scrollRafId) {
      cancelAnimationFrame(scrollRafId);
      scrollRafId = null;
    }

    // Resume animations if paused
    if (isPaused) {
      document.getAnimations().forEach(a => a.play());
      isPaused = false;
    }
    isBrowsing = false;
  }

  // ---------------------------------------------------------------------------
  // Message listener (from popup or background)
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'TOGGLE_ANNOTATOR') {
      if (isActive) {
        deactivate();
      } else {
        activate();
      }
      sendResponse({ active: isActive });
    } else if (msg.type === 'GET_STATE') {
      sendResponse({
        active: isActive,
        annotationCount: annotations.length,
        annotations: annotations.map(({ _element, ...rest }) => rest)
      });
    } else if (msg.type === 'ACTIVATE') {
      activate();
      sendResponse({ active: true });
    }
    // No async responses needed — don't return true
  });

  // ---------------------------------------------------------------------------
  // Runtime disconnect handler
  // ---------------------------------------------------------------------------
  // When the extension is updated/reloaded, chrome.runtime becomes invalid.
  // Wrap sendMessage calls to avoid "Extension context invalidated" errors.
  function safeSendMessage(msg, callback) {
    try {
      if (runtimeDisconnected) return;
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          runtimeDisconnected = true;
          console.warn('[Funny Annotator] Extension disconnected:', chrome.runtime.lastError.message);
          return;
        }
        if (callback) callback(response);
      });
    } catch (_) {
      runtimeDisconnected = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Styles (loaded from external content.css)
  // ---------------------------------------------------------------------------
  async function loadStyles() {
    try {
      const url = chrome.runtime.getURL('content.css');
      const res = await fetch(url);
      return await res.text();
    } catch (_) {
      return ''; // Styles will be missing but extension won't crash
    }
  }
})();
