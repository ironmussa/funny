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

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ElementData {
  element: string;
  elementPath: string;
  elementName: string;
  x: number;
  y: number;
  boundingBox: BoundingBox;
  componentTree: string;
  cssClasses: string;
  computedStyles: string;
  accessibility: string;
  nearbyText: string;
  isFixed: boolean;
  fullPath: string;
  nearbyElements: string;
  outerHTML: string;
  _element: Element; // private ref, not serialized
}

interface Annotation {
  id: string;
  prompt: string;
  timestamp: number;
  url: string;
  selectedText: string;
  status: string;
  elements: ElementData[];
}

interface AnnotationOverlay {
  hl: HTMLDivElement;
  badge: HTMLDivElement;
  element: Element;
}

// ---------------------------------------------------------------------------
// Prevent double-injection
// ---------------------------------------------------------------------------
if (window.__funnyAnnotatorActive) {
  // Already injected — bail out. esbuild IIFE wraps this in an arrow
  // function so `return` is valid here (it exits the IIFE, not the module).
  throw new Error('Funny Annotator already active');
}
window.__funnyAnnotatorActive = true;

console.log('[Funny Annotator] v2.1 loaded', new Date().toISOString());

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let isActive = false;
let annotations: Annotation[] = [];
let _annotationCounter = 0;
let hoveredElement: Element | null = null;
let isPaused = false;
let isBrowsing = false;
let annotationsVisible = true;
let isDragging = false;
let dragOffset = { x: 0, y: 0 };
let scrollRafId: number | null = null;
let runtimeDisconnected = false;

// Multi-select state (Ctrl+click)
let multiSelectElements: Element[] = [];
let multiSelectOverlays: AnnotationOverlay[] = [];
let pendingMultiSelectElements: Element[] | null = null;
let multiSelectContainer: HTMLDivElement;

// Cache for component name lookups (WeakMap so GC can collect removed elements)
const componentNameCache = new WeakMap<Element, string>();
const componentTreeCache = new WeakMap<Element, string>();

// DOM refs (created once, reused)
let shadowHost: HTMLDivElement;
let shadowRoot: ShadowRoot;
let toolbarEl: HTMLDivElement;
let hoverHighlight: HTMLDivElement;
let hoverLabel: HTMLDivElement;
let popover: HTMLDivElement;
let settingsPanel: HTMLDivElement;
let historyPanel: HTMLDivElement;
let badgeContainer: HTMLDivElement;
let highlightContainer: HTMLDivElement;

// Cached popover element refs (set after createPopover)
let popoverTextarea: HTMLTextAreaElement;
let popoverError: HTMLDivElement;
let popoverElementName: HTMLSpanElement;
let popoverElementList: HTMLDivElement;
let popoverAddBtn: HTMLButtonElement;
let popoverDeleteBtn: HTMLButtonElement;
let popoverProjectName: HTMLSpanElement;
let popoverSendBtn: HTMLButtonElement;

// Drag listener refs (for cleanup)
let dragMoveHandler: ((e: MouseEvent) => void) | null = null;
let dragUpHandler: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Shadow DOM setup
// ---------------------------------------------------------------------------
async function createShadowHost() {
  shadowHost = document.createElement('div');
  shadowHost.id = 'funny-annotator-host';
  shadowHost.style.cssText =
    'all:initial; position:fixed; top:0; left:0; width:0; height:0; z-index:2147483647; pointer-events:none;';
  document.documentElement.appendChild(shadowHost);
  shadowRoot = shadowHost.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = await loadStyles();
  shadowRoot.appendChild(style);

  // Containers
  highlightContainer = createElement('div', 'highlight-container');
  badgeContainer = createElement('div', 'badge-container');
  multiSelectContainer = createElement('div', 'multi-select-container');
  shadowRoot.appendChild(highlightContainer);
  shadowRoot.appendChild(badgeContainer);
  shadowRoot.appendChild(multiSelectContainer);

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

  // History panel (hidden by default)
  historyPanel = createHistoryPanel();
  shadowRoot.appendChild(historyPanel);

  // Toolbar
  toolbarEl = createToolbar();
  shadowRoot.appendChild(toolbarEl);
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

// ---------------------------------------------------------------------------
// Element info extraction
// ---------------------------------------------------------------------------
function getElementName(el: Element): string {
  // Try framework component name first (React, Vue, Angular, Svelte)
  const compName = getComponentName(el);
  if (compName) return compName;

  // Fallback: tag + class or id
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`;
  if (el.className && typeof el.className === 'string') {
    const cls = el.className
      .split(/\s+/)
      .filter((c) => c && !c.startsWith('funny-'))
      .slice(0, 2)
      .join('.');
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

function queryComponentInfo(el: Element) {
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
  } catch {
    componentNameCache.set(el, '');
    componentTreeCache.set(el, '');
  }
}

function getComponentName(el: Element): string | null {
  queryComponentInfo(el);
  return componentNameCache.get(el) || null;
}

function getComponentTree(el: Element): string {
  queryComponentInfo(el);
  return componentTreeCache.get(el) || '';
}

function getCSSSelector(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== document.body && current !== document.documentElement) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector += `#${current.id}`;
      parts.unshift(selector);
      break;
    }
    if (current.className && typeof current.className === 'string') {
      const classes = current.className
        .trim()
        .split(/\s+/)
        .filter((c) => c && !c.startsWith('funny-'))
        .slice(0, 2);
      if (classes.length) selector += `.${classes.join('.')}`;
    }
    // Add nth-of-type if needed for disambiguation
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === current!.tagName);
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

function getComputedStylesSummary(el: Element): string {
  const cs = window.getComputedStyle(el);
  const props = [
    'display',
    'position',
    'width',
    'height',
    'margin',
    'padding',
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'color',
    'background-color',
    'border',
    'border-radius',
    'opacity',
    'overflow',
    'flex-direction',
    'justify-content',
    'align-items',
    'gap',
  ];
  return props
    .map((p) => {
      const v = cs.getPropertyValue(p);
      if (
        !v ||
        v === 'none' ||
        v === 'normal' ||
        v === 'auto' ||
        v === '0px' ||
        v === 'rgba(0, 0, 0, 0)'
      )
        return null;
      return `${p}: ${v}`;
    })
    .filter(Boolean)
    .join('; ');
}

function getAccessibilityInfo(el: Element): string {
  const info: string[] = [];
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

function getNearbyText(el: Element): string {
  const texts: string[] = [];
  const prev = el.previousElementSibling;
  if (prev?.textContent?.trim()) texts.push(prev.textContent.trim().slice(0, 40));
  const own = el.textContent?.trim();
  if (own) texts.push(own.slice(0, 60));
  const next = el.nextElementSibling;
  if (next?.textContent?.trim()) texts.push(next.textContent.trim().slice(0, 40));
  return texts.join(' | ') || 'none';
}

function getFullPath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== document.documentElement) {
    parts.unshift(current.tagName.toLowerCase());
    current = current.parentElement;
  }
  return parts.join(' > ');
}

function getNearbyElements(el: Element): string {
  const items: string[] = [];
  const prev = el.previousElementSibling;
  if (prev)
    items.push(
      `prev: ${prev.tagName.toLowerCase()}${prev.className && typeof prev.className === 'string' ? '.' + prev.className.split(/\s+/)[0] : ''}`,
    );
  const next = el.nextElementSibling;
  if (next)
    items.push(
      `next: ${next.tagName.toLowerCase()}${next.className && typeof next.className === 'string' ? '.' + next.className.split(/\s+/)[0] : ''}`,
    );
  const parent = el.parentElement;
  if (parent)
    items.push(
      `parent: ${parent.tagName.toLowerCase()}${parent.className && typeof parent.className === 'string' ? '.' + parent.className.split(/\s+/)[0] : ''} (${parent.children.length} children)`,
    );
  return items.join(', ') || 'none';
}

// ---------------------------------------------------------------------------
// Hover highlight
// ---------------------------------------------------------------------------
function showHoverHighlight(el: Element) {
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
let annotationOverlays: AnnotationOverlay[] = [];

function renderAnnotations() {
  // Full rebuild: clears and recreates all overlays.
  // Called when annotations array changes (add/edit/delete/toggle visibility).
  annotationOverlays = [];
  highlightContainer.innerHTML = '';
  badgeContainer.innerHTML = '';

  if (!annotationsVisible) return;

  annotations.forEach((ann, i) => {
    // Each annotation can have one or more elements
    for (const elemData of ann.elements) {
      const el = elemData._element;
      if (!el || !document.contains(el)) continue;
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

      // Badge (same number for all elements in the group)
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
    }
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

// ---------------------------------------------------------------------------
// Multi-select highlights (Ctrl+click pending selection)
// ---------------------------------------------------------------------------
function renderMultiSelectHighlights() {
  multiSelectOverlays = [];
  multiSelectContainer.innerHTML = '';

  multiSelectElements.forEach((el, i) => {
    if (!document.contains(el)) return;
    const rect = el.getBoundingClientRect();

    const hl = createElement('div', 'multi-select-highlight');
    hl.style.cssText = `
      position: fixed;
      top: ${rect.top}px;
      left: ${rect.left}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      pointer-events: none;
    `;
    multiSelectContainer.appendChild(hl);

    const badge = createElement('div', 'multi-select-badge');
    badge.textContent = String(i + 1);
    badge.style.cssText = `
      position: fixed;
      top: ${rect.top - 10}px;
      left: ${rect.right - 10}px;
      pointer-events: none;
    `;
    multiSelectContainer.appendChild(badge);

    multiSelectOverlays.push({ hl, badge, element: el });
  });
}

function repositionMultiSelectHighlights() {
  for (const { hl, badge, element } of multiSelectOverlays) {
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

function clearMultiSelect() {
  multiSelectElements = [];
  multiSelectOverlays = [];
  pendingMultiSelectElements = null;
  multiSelectContainer.innerHTML = '';
}

// Reposition on scroll/resize (throttled via rAF)
function onScrollOrResize() {
  if (!isActive) return;
  if (scrollRafId) return; // already scheduled
  scrollRafId = requestAnimationFrame(() => {
    scrollRafId = null;
    // Move existing overlays (no DOM rebuild)
    repositionAnnotations();
    repositionMultiSelectHighlights();
    // Update hover highlight position
    if (hoveredElement && document.contains(hoveredElement)) {
      const rect = hoveredElement.getBoundingClientRect();
      hoverHighlight.style.top = `${rect.top}px`;
      hoverHighlight.style.left = `${rect.left}px`;
      hoverHighlight.style.width = `${rect.width}px`;
      hoverHighlight.style.height = `${rect.height}px`;
    }
    // Update popover position
    if (
      popover.style.display !== 'none' &&
      pendingAnnotationElement &&
      document.contains(pendingAnnotationElement)
    ) {
      const r = pendingAnnotationElement.getBoundingClientRect();
      positionPopoverAtPoint(r.left, r.top);
    }
  });
}

// ---------------------------------------------------------------------------
// Popover (annotation form)
// ---------------------------------------------------------------------------

function resetDetailsCollapsed() {
  const body = popover.querySelector('.popover-details-body') as HTMLDivElement;
  const arrow = popover.querySelector('.popover-details-arrow') as SVGElement;
  if (body) body.style.display = 'none';
  if (arrow) arrow.classList.remove('popover-details-arrow-open');
}

function loadPopoverProjectName() {
  safeSendMessage({ type: 'GET_CONFIG' }, (config: any) => {
    if (!config?.projectId) {
      popoverProjectName.textContent = 'No project';
      popoverProjectName.classList.add('popover-project-empty');
      return;
    }
    // Fetch projects to get the name
    safeSendMessage({ type: 'FETCH_PROJECTS' }, (result: any) => {
      if (result?.success && result.projects) {
        const project = result.projects.find((p: any) => p.id === config.projectId);
        popoverProjectName.textContent = project?.name || 'No project';
        popoverProjectName.classList.toggle('popover-project-empty', !project);
      } else {
        popoverProjectName.textContent = 'No project';
        popoverProjectName.classList.add('popover-project-empty');
      }
    });
  });
}

function createPopover(): HTMLDivElement {
  const pop = createElement('div', 'popover');
  pop.style.display = 'none';
  pop.innerHTML = `
    <button class="popover-close-btn" title="Close">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>
    <div class="popover-project">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
      </svg>
      <span class="popover-project-name">Loading...</span>
    </div>
    <div class="popover-header">
      <button class="popover-element-toggle">
        <span class="popover-element-name"></span>
        <svg class="popover-details-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
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
    <div class="popover-element-list" style="display:none"></div>
    <textarea class="popover-textarea" placeholder="What should be done with this element?" rows="3"></textarea>
    <div class="popover-error" style="display:none">Please describe the action needed.</div>
    <div class="popover-actions">
      <button class="popover-delete" style="display:none">Delete</button>
      <div class="popover-actions-right">
        <button class="popover-add">Add</button>
        <button class="popover-send-btn">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
          Send
        </button>
        <button class="popover-cancel">Cancel</button>
      </div>
    </div>
  `;

  // Cache element refs
  popoverTextarea = pop.querySelector('.popover-textarea') as HTMLTextAreaElement;
  popoverError = pop.querySelector('.popover-error') as HTMLDivElement;
  popoverElementName = pop.querySelector('.popover-element-name') as HTMLSpanElement;
  popoverElementList = pop.querySelector('.popover-element-list') as HTMLDivElement;
  popoverAddBtn = pop.querySelector('.popover-add') as HTMLButtonElement;
  popoverDeleteBtn = pop.querySelector('.popover-delete') as HTMLButtonElement;
  popoverProjectName = pop.querySelector('.popover-project-name') as HTMLSpanElement;
  popoverSendBtn = pop.querySelector('.popover-send-btn') as HTMLButtonElement;

  // Send to Funny from popover
  popoverSendBtn.addEventListener('click', () => {
    // First add the current annotation, then send all
    addAnnotationFromPopover();
    if (annotations.length > 0) {
      sendToFunny();
    }
  });

  // Element name toggles details
  const elementToggle = pop.querySelector('.popover-element-toggle') as HTMLButtonElement;
  const detailsBody = pop.querySelector('.popover-details-body') as HTMLDivElement;
  const detailsArrow = pop.querySelector('.popover-details-arrow') as SVGElement;
  elementToggle.addEventListener('click', () => {
    const open = detailsBody.style.display !== 'none';
    detailsBody.style.display = open ? 'none' : 'block';
    detailsArrow.classList.toggle('popover-details-arrow-open', !open);
  });

  // Events
  pop.querySelector('.popover-cancel')!.addEventListener('click', () => hidePopover());
  pop.querySelector('.popover-close-btn')!.addEventListener('click', () => hidePopover());
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

let pendingAnnotationElement: Element | null = null;
let editingAnnotationIndex = -1;

function populateElementDetails(el: Element) {
  const tag = el.tagName.toLowerCase();
  const classes = (typeof el.className === 'string' ? el.className : '').trim();
  const component = getComponentTree(el);
  const a11y = getAccessibilityInfo(el);

  // Selector
  (popover.querySelector('.popover-detail-selector') as HTMLElement).textContent =
    tag + (el.id ? `#${el.id}` : '');

  // Classes
  const classesEl = popover.querySelector('.popover-detail-classes') as HTMLElement;
  classesEl.textContent = classes || 'none';

  // Component tree (only show if detected)
  const compRow = popover.querySelector('.popover-detail-component-row') as HTMLDivElement;
  if (component) {
    compRow.style.display = '';
    (popover.querySelector('.popover-detail-component') as HTMLElement).textContent = component;
  } else {
    compRow.style.display = 'none';
  }

  // Computed styles as individual rows
  const stylesContainer = popover.querySelector('.popover-detail-styles') as HTMLDivElement;
  stylesContainer.innerHTML = '';
  const cs = window.getComputedStyle(el);
  const styleGroups = [
    {
      label: 'Layout',
      props: [
        'display',
        'position',
        'width',
        'height',
        'flex-direction',
        'justify-content',
        'align-items',
        'gap',
      ],
    },
    { label: 'Spacing', props: ['margin', 'padding'] },
    {
      label: 'Typography',
      props: ['font-family', 'font-size', 'font-weight', 'line-height', 'color'],
    },
    {
      label: 'Visual',
      props: ['background-color', 'border', 'border-radius', 'opacity', 'overflow'],
    },
  ];
  const skip = new Set(['none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)', 'visible', 'static']);
  for (const group of styleGroups) {
    const entries: { prop: string; value: string }[] = [];
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
  const a11yRow = popover.querySelector('.popover-detail-a11y-row') as HTMLDivElement;
  if (a11y && a11y !== 'none') {
    a11yRow.style.display = '';
    (popover.querySelector('.popover-detail-a11y') as HTMLElement).textContent = a11y;
  } else {
    a11yRow.style.display = 'none';
  }
}

function showPopoverForElement(el: Element, clickX: number, clickY: number) {
  pendingAnnotationElement = el;
  editingAnnotationIndex = -1;
  pendingMultiSelectElements = null;

  popoverElementName.textContent = getElementName(el);
  popoverElementList.style.display = 'none';
  popoverElementList.innerHTML = '';
  popoverTextarea.value = '';
  popoverTextarea.placeholder = 'What should be done with this element?';
  popoverTextarea.classList.remove('popover-textarea-error');
  popoverError.style.display = 'none';
  popoverAddBtn.textContent = 'Add';
  popoverDeleteBtn.style.display = 'none';
  resetDetailsCollapsed();
  const header = popover.querySelector('.popover-header') as HTMLDivElement;
  if (header) header.style.display = '';
  populateElementDetails(el);

  loadPopoverProjectName();
  positionPopoverAtPoint(clickX, clickY);
  popover.style.display = 'block';
  popoverTextarea.focus();
}

function showPopoverForEdit(ann: Annotation, index: number, clickX: number, clickY: number) {
  editingAnnotationIndex = index;
  popoverTextarea.value = ann.prompt;
  popoverTextarea.classList.remove('popover-textarea-error');
  popoverError.style.display = 'none';
  popoverAddBtn.textContent = 'Update';
  popoverDeleteBtn.style.display = 'inline-block';

  if (ann.elements.length > 1) {
    // Multi-element annotation: show chips, hide details
    pendingAnnotationElement = null;
    pendingMultiSelectElements = ann.elements.map((e) => e._element);
    popoverElementName.textContent = `${ann.elements.length} elements selected`;
    popoverTextarea.placeholder = 'What should be done with these elements?';
    popoverElementList.innerHTML = '';
    popoverElementList.style.display = 'flex';
    ann.elements.forEach((elemData) => {
      const chip = createElement('span', 'popover-element-chip');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = elemData.elementName;
      nameSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
      chip.appendChild(nameSpan);
      popoverElementList.appendChild(chip);
    });
    const header = popover.querySelector('.popover-header') as HTMLDivElement;
    if (header) header.style.display = 'none';
  } else {
    // Single-element annotation
    const elemData = ann.elements[0];
    pendingAnnotationElement = elemData._element;
    pendingMultiSelectElements = null;
    popoverElementName.textContent = elemData.elementName;
    popoverTextarea.placeholder = 'What should be done with this element?';
    popoverElementList.style.display = 'none';
    popoverElementList.innerHTML = '';
    resetDetailsCollapsed();
    const header = popover.querySelector('.popover-header') as HTMLDivElement;
    if (header) header.style.display = '';
    populateElementDetails(elemData._element);
  }

  loadPopoverProjectName();
  positionPopoverAtPoint(clickX, clickY);
  popover.style.display = 'block';
  popoverTextarea.focus();
}

function showPopoverForMultiSelect(clickX: number, clickY: number) {
  pendingAnnotationElement = null;
  editingAnnotationIndex = -1;
  pendingMultiSelectElements = [...multiSelectElements];

  // Header shows count
  popoverElementName.textContent = `${pendingMultiSelectElements.length} elements selected`;

  // Populate chip list
  popoverElementList.innerHTML = '';
  popoverElementList.style.display = 'flex';
  pendingMultiSelectElements.forEach((el, i) => {
    const chip = createElement('span', 'popover-element-chip');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = getElementName(el);
    nameSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
    chip.appendChild(nameSpan);

    const removeBtn = createElement('button', 'popover-chip-remove');
    removeBtn.innerHTML = '&times;';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromMultiSelect(i);
    });
    chip.appendChild(removeBtn);
    popoverElementList.appendChild(chip);
  });

  popoverTextarea.value = '';
  popoverTextarea.placeholder = 'What should be done with these elements?';
  popoverTextarea.classList.remove('popover-textarea-error');
  popoverError.style.display = 'none';
  popoverAddBtn.textContent = 'Add';
  popoverDeleteBtn.style.display = 'none';

  // Hide element header (not useful for multi-select, chips are shown instead)
  const header = popover.querySelector('.popover-header') as HTMLDivElement;
  if (header) header.style.display = 'none';

  loadPopoverProjectName();
  positionPopoverAtPoint(clickX, clickY);
  popover.style.display = 'block';
  popoverTextarea.focus();
}

function removeFromMultiSelect(index: number) {
  if (!pendingMultiSelectElements) return;

  // Remove from pending list
  pendingMultiSelectElements.splice(index, 1);

  // Also remove from the live multi-select array
  multiSelectElements = [...pendingMultiSelectElements];
  renderMultiSelectHighlights();

  if (pendingMultiSelectElements.length === 0) {
    // No elements left, close popover
    hidePopover();
    return;
  }

  // Re-render chips
  popoverElementName.textContent = `${pendingMultiSelectElements.length} elements selected`;
  popoverElementList.innerHTML = '';
  pendingMultiSelectElements.forEach((el, i) => {
    const chip = createElement('span', 'popover-element-chip');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = getElementName(el);
    nameSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
    chip.appendChild(nameSpan);

    const removeBtn = createElement('button', 'popover-chip-remove');
    removeBtn.innerHTML = '&times;';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromMultiSelect(i);
    });
    chip.appendChild(removeBtn);
    popoverElementList.appendChild(chip);
  });
}

function positionPopoverAtPoint(x: number, y: number) {
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
  pendingMultiSelectElements = null;
  hideHoverHighlight();
  // Clear multi-select visuals if popover is dismissed
  if (multiSelectElements.length > 0) {
    clearMultiSelect();
  }
}

function buildElementData(el: Element): ElementData {
  const rect = el.getBoundingClientRect();
  return {
    element: el.tagName.toLowerCase(),
    elementPath: getCSSSelector(el),
    elementName: getElementName(el),
    x: Math.round(((rect.left + rect.width / 2) / window.innerWidth) * 100 * 10) / 10,
    y: Math.round(rect.top + window.scrollY),
    boundingBox: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    componentTree: getComponentTree(el),
    cssClasses: (typeof el.className === 'string' ? el.className : '').trim(),
    computedStyles: getComputedStylesSummary(el),
    accessibility: getAccessibilityInfo(el),
    nearbyText: getNearbyText(el),
    isFixed: ['fixed', 'sticky'].includes(window.getComputedStyle(el).position),
    fullPath: getFullPath(el),
    nearbyElements: getNearbyElements(el),
    outerHTML: el.outerHTML.slice(0, 2000),
    _element: el,
  };
}

function buildAnnotation(prompt: string, elements: Element[]): Annotation {
  return {
    id: `ann_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    prompt,
    timestamp: Date.now(),
    url: window.location.href,
    selectedText: window.getSelection()?.toString()?.trim() || '',
    status: 'pending',
    elements: elements.map(buildElementData),
  };
}

function addAnnotationFromPopover() {
  const prompt = popoverTextarea.value.trim();

  // Validate: prompt is required
  if (!prompt) {
    popoverTextarea.classList.add('popover-textarea-error');
    popoverError.style.display = 'block';
    popoverTextarea.focus();
    return;
  }

  // Editing an existing annotation (single or multi-element)
  if (editingAnnotationIndex >= 0) {
    const existing = annotations[editingAnnotationIndex];
    const elements = existing.elements.map((e) => e._element);
    annotations[editingAnnotationIndex] = buildAnnotation(prompt, elements);
  } else if (pendingMultiSelectElements && pendingMultiSelectElements.length > 0) {
    // New multi-select annotation
    _annotationCounter++;
    annotations.push(buildAnnotation(prompt, pendingMultiSelectElements));
    clearMultiSelect();
  } else {
    // New single-element annotation
    const el = pendingAnnotationElement;
    if (!el) return;
    _annotationCounter++;
    annotations.push(buildAnnotation(prompt, [el]));
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
function createToolbar(): HTMLDivElement {
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
    <button class="toolbar-btn" data-action="history" title="Sent history">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <polyline points="12 6 12 12 16 14"></polyline>
      </svg>
    </button>
    <div class="toolbar-separator"></div>
    <button class="toolbar-btn toolbar-btn-send" data-action="send" title="Send to Funny">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="22" y1="2" x2="11" y2="13"></line>
        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
      </svg>
      <span class="toolbar-send-label">Send</span>
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
    const btn = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (!btn) return;
    e.stopPropagation();
    handleToolbarAction(btn.dataset.action!);
  });

  // Drag to reposition (only from the drag handle)
  const dragHandle = tb.querySelector('.toolbar-drag-handle') as HTMLDivElement;
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
  dragMoveHandler = (e: MouseEvent) => {
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
  const count = toolbarEl.querySelector('.toolbar-count') as HTMLSpanElement;
  const label = toolbarEl.querySelector('.toolbar-send-label') as HTMLSpanElement;
  if (annotations.length > 0) {
    count.textContent = String(annotations.length);
    count.style.display = 'inline-flex';
    label.textContent = `Send (${annotations.length})`;
  } else {
    count.style.display = 'none';
    label.textContent = 'Send';
  }
}

function loadToolbarProjectName() {
  safeSendMessage({ type: 'GET_FULL_CONFIG' }, (data: any) => {
    if (!data?.success) return;
    const config = data.config || {};
    const projects: Array<{ id: string; name: string }> = data.projects || [];
    const project = config.projectId ? projects.find((p) => p.id === config.projectId) : null;
    updateToolbarProjectName(project?.name || '');
  });
}

function updateToolbarProjectName(name: string) {
  const el = toolbarEl.querySelector('.toolbar-project') as HTMLSpanElement;
  if (!el) return;
  if (name) {
    el.textContent = name;
    el.style.display = 'inline';
    el.title = `Project: ${name}`;
  } else {
    el.textContent = '';
    el.style.display = 'none';
  }
}

function handleToolbarAction(action: string) {
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
      _annotationCounter = 0;
      clearMultiSelect();
      renderAnnotations();
      updateToolbarCount();
      break;
    case 'settings':
      toggleSettingsPanel();
      break;
    case 'history':
      toggleHistoryPanel();
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
  const btn = toolbarEl.querySelector('[data-action="toggle-visibility"]') as HTMLButtonElement;
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
  const btn = toolbarEl.querySelector('[data-action="pause"]') as HTMLButtonElement;
  if (isPaused) {
    document.getAnimations().forEach((a) => a.pause());
    btn.classList.add('toolbar-btn-active');
    btn.title = 'Resume animations';
    showToast('Animations paused — annotate the current frame');
  } else {
    document.getAnimations().forEach((a) => a.play());
    btn.classList.remove('toolbar-btn-active');
    btn.title = 'Pause animations';
  }
}

function toggleBrowseMode() {
  isBrowsing = !isBrowsing;
  const btn = toolbarEl.querySelector('[data-action="browse"]') as HTMLButtonElement;
  if (isBrowsing) {
    btn.classList.add('toolbar-btn-active');
    btn.title = 'Annotate mode — select elements';
    hideHoverHighlight();
    hidePopover();
    clearMultiSelect();
  } else {
    btn.classList.remove('toolbar-btn-active');
    btn.title = 'Browse mode — navigate the page';
  }
}

// ---------------------------------------------------------------------------
// Settings panel (inline, replaces popup)
// ---------------------------------------------------------------------------
function createSettingsPanel(): HTMLDivElement {
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
  panel.querySelector('.settings-close-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    hideSettingsPanel();
  });

  // Connect button
  panel.querySelector('.settings-connect-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    testSettingsConnection();
  });

  // Auto-save on change
  panel.querySelectorAll('.settings-select, .settings-input').forEach((el) => {
    el.addEventListener('change', (e) => {
      e.stopPropagation();
      const target = el as HTMLSelectElement | HTMLInputElement;
      // If provider changed, repopulate models
      if (target.dataset.key === 'provider') {
        populateSettingsModels(target.value);
      }
      // If project changed, apply project defaults to provider/model/mode
      if (target.dataset.key === 'projectId') {
        applyProjectDefaults(target.value);
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
let settingsProviderData: Record<string, any> | null = null;
// Cached projects data (includes per-project defaults)
let settingsProjectsData: Array<{
  id: string;
  name: string;
  defaultProvider?: string;
  defaultModel?: string;
  defaultMode?: string;
}> = [];

function toggleSettingsPanel() {
  if (settingsPanel.style.display === 'block') {
    hideSettingsPanel();
  } else {
    showSettingsPanel();
  }
}

function showSettingsPanel() {
  hideHistoryPanel();
  settingsPanel.style.display = 'block';
  positionSettingsPanel();
  loadSettingsData();
  updateFrameworkStatus();
}

function detectFramework(): string {
  // Ask page-bridge.js (MAIN world) to detect JS frameworks.
  // Returns a comma-separated string like "React, Next.js" or "" if none found.
  try {
    document.documentElement.removeAttribute('data-funny-framework');
    document.dispatchEvent(new Event('__funny_detect_framework'));
    const result = document.documentElement.getAttribute('data-funny-framework') || '';
    console.log('[Funny Annotator] Framework detect result:', result || 'none');
    document.documentElement.removeAttribute('data-funny-framework');
    return result;
  } catch {
    return '';
  }
}

function updateFrameworkStatus() {
  const el = settingsPanel.querySelector('.settings-react-status') as HTMLDivElement;
  const frameworks = detectFramework();
  if (frameworks) {
    el.style.display = 'none';
    el.innerHTML = '';
  } else {
    el.style.display = 'flex';
    el.className = 'settings-react-status settings-react-no';
    el.innerHTML =
      '<span class="settings-react-dot settings-react-dot-no"></span> No JS framework detected — component tree data will not be included in annotations';
  }
}

function hideSettingsPanel() {
  settingsPanel.style.display = 'none';
}

function positionSettingsPanel() {
  const settingsBtn = toolbarEl.querySelector('[data-action="settings"]') as HTMLButtonElement;
  const btnRect = settingsBtn.getBoundingClientRect();
  const panelWidth = 340;
  const gap = 12;

  // Center panel horizontally on the settings button
  let left = btnRect.left + btnRect.width / 2 - panelWidth / 2;
  const top = btnRect.top - gap;

  // Keep within viewport
  if (left + panelWidth > window.innerWidth - 8) left = window.innerWidth - panelWidth - 8;
  if (left < 8) left = 8;

  // Show above by default; measure height after display
  settingsPanel.style.left = `${left}px`;
  settingsPanel.style.top = 'auto';
  settingsPanel.style.bottom = `${window.innerHeight - top}px`;
}

async function loadSettingsData() {
  const statusEl = settingsPanel.querySelector('.settings-status') as HTMLDivElement;
  statusEl.textContent = 'Loading...';
  statusEl.className = 'settings-status';

  try {
    const data = await new Promise<any>((resolve) => {
      safeSendMessage({ type: 'GET_FULL_CONFIG' }, resolve);
    });

    if (!data?.success) {
      statusEl.textContent = data?.error || 'Failed to load config';
      statusEl.className = 'settings-status settings-status-error';
      return;
    }

    const config = data.config || {};

    // Populate server URL
    const serverInput = settingsPanel.querySelector('[data-key="serverUrl"]') as HTMLInputElement;
    serverInput.value = config.serverUrl || 'http://localhost:3001';

    // Populate projects
    settingsProjectsData = data.projects || [];
    const projectSelect = settingsPanel.querySelector(
      '[data-key="projectId"]',
    ) as HTMLSelectElement;
    projectSelect.innerHTML = '<option value="">Select a project...</option>';
    settingsProjectsData.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === config.projectId) opt.selected = true;
      projectSelect.appendChild(opt);
    });

    // Look up project defaults for the selected project
    const selectedProject = config.projectId
      ? settingsProjectsData.find((p) => p.id === config.projectId)
      : null;

    // Populate mode — project default > fallback
    const modeSelect = settingsPanel.querySelector('[data-key="mode"]') as HTMLSelectElement;
    const effectiveMode = selectedProject?.defaultMode || config.mode || 'worktree';
    modeSelect.value = effectiveMode;

    // Populate providers
    settingsProviderData = data.providers || {};
    const providerSelect = settingsPanel.querySelector(
      '[data-key="provider"]',
    ) as HTMLSelectElement;
    providerSelect.innerHTML = '';
    const available = Object.entries(settingsProviderData!).filter(
      ([_, info]) => (info as any).available,
    );

    if (available.length === 0) {
      providerSelect.innerHTML = '<option value="">No providers</option>';
    } else {
      // Resolve provider: project default > saved config > first available
      const projectDefaultProvider = selectedProject?.defaultProvider;
      const effectiveProvider =
        projectDefaultProvider && settingsProviderData![projectDefaultProvider]?.available
          ? projectDefaultProvider
          : config.provider && settingsProviderData![config.provider]?.available
            ? config.provider
            : available[0][0];
      available.forEach(([key, info]) => {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = (info as any).label || key;
        if (key === effectiveProvider) opt.selected = true;
        providerSelect.appendChild(opt);
      });
      providerSelect.value = effectiveProvider;
      // Resolve model: project default > saved config > provider default
      const effectiveModel = selectedProject?.defaultModel || config.model || undefined;
      populateSettingsModels(effectiveProvider, effectiveModel);
    }

    // Connection state (dot + connect button + status text)
    const dot = settingsPanel.querySelector('.settings-dot') as HTMLSpanElement;
    const connectBtn = settingsPanel.querySelector('.settings-connect-btn') as HTMLButtonElement;
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
  } catch {
    statusEl.textContent = 'Error loading settings';
    statusEl.className = 'settings-status settings-status-error';
  }
}

function applyProjectDefaults(projectId: string) {
  const project = settingsProjectsData.find((p) => p.id === projectId);
  if (!project || !settingsProviderData) return;

  const available = Object.entries(settingsProviderData).filter(
    ([_, info]) => (info as any).available,
  );
  if (available.length === 0) return;

  // Resolve provider: project default > 'claude'
  const effectiveProvider = project.defaultProvider || 'claude';
  const providerSelect = settingsPanel.querySelector('[data-key="provider"]') as HTMLSelectElement;
  if (settingsProviderData[effectiveProvider]?.available) {
    providerSelect.value = effectiveProvider;
  }

  // Resolve model: project default > provider's default
  const effectiveModel = project.defaultModel || '';
  populateSettingsModels(providerSelect.value, effectiveModel);

  // Resolve mode: project default > 'worktree'
  const modeSelect = settingsPanel.querySelector('[data-key="mode"]') as HTMLSelectElement;
  modeSelect.value = project.defaultMode || 'worktree';
}

function populateSettingsModels(provider: string, selectedModel?: string) {
  const modelSelect = settingsPanel.querySelector('[data-key="model"]') as HTMLSelectElement;
  modelSelect.innerHTML = '';

  if (!settingsProviderData || !settingsProviderData[provider]) {
    modelSelect.innerHTML = '<option value="">-</option>';
    return;
  }

  const info = settingsProviderData[provider];
  const models: Array<{ value: string; label: string }> =
    info.modelsWithLabels || info.models?.map((m: string) => ({ value: m, label: m })) || [];
  const effectiveModel =
    selectedModel && models.some((m) => m.value === selectedModel)
      ? selectedModel
      : info.defaultModel || models[0]?.value || '';

  models.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    if (m.value === effectiveModel) opt.selected = true;
    modelSelect.appendChild(opt);
  });

  modelSelect.value = effectiveModel;
}

function saveSettings() {
  const config: Record<string, string> = {};
  settingsPanel.querySelectorAll('[data-key]').forEach((el) => {
    const input = el as HTMLSelectElement | HTMLInputElement;
    config[input.dataset.key!] = input.value;
  });
  safeSendMessage({ type: 'SAVE_CONFIG', config });

  // Update the project name in the toolbar
  const projectId = config.projectId;
  const project = projectId ? settingsProjectsData.find((p) => p.id === projectId) : null;
  updateToolbarProjectName(project?.name || '');
}

async function testSettingsConnection() {
  const statusEl = settingsPanel.querySelector('.settings-status') as HTMLDivElement;
  const connectBtn = settingsPanel.querySelector('.settings-connect-btn') as HTMLButtonElement;
  const serverUrl = (
    settingsPanel.querySelector('[data-key="serverUrl"]') as HTMLInputElement
  ).value.trim();
  statusEl.textContent = 'Connecting...';
  statusEl.className = 'settings-status';
  connectBtn.className = 'settings-connect-btn';

  try {
    const result = await new Promise<any>((resolve) => {
      safeSendMessage({ type: 'TEST_CONNECTION', serverUrl }, resolve);
    });

    const dot = settingsPanel.querySelector('.settings-dot') as HTMLSpanElement;
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
  } catch {
    connectBtn.className = 'settings-connect-btn settings-connect-btn-err';
    statusEl.textContent = 'Connection failed';
    statusEl.className = 'settings-status settings-status-error';
  }
}

// ---------------------------------------------------------------------------
// History panel
// ---------------------------------------------------------------------------
function createHistoryPanel(): HTMLDivElement {
  const panel = createElement('div', 'history-panel');
  panel.style.display = 'none';
  panel.innerHTML = `
    <div class="history-header">
      <span class="history-title">Sent History</span>
      <button class="history-close-btn" title="Close">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
    <div class="history-body"></div>
  `;

  panel.querySelector('.history-close-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    hideHistoryPanel();
  });

  panel.addEventListener('click', (e) => e.stopPropagation());
  panel.addEventListener('mousedown', (e) => e.stopPropagation());

  return panel;
}

function toggleHistoryPanel() {
  if (historyPanel.style.display === 'block') {
    hideHistoryPanel();
  } else {
    showHistoryPanel();
  }
}

function showHistoryPanel() {
  hideSettingsPanel();
  historyPanel.style.display = 'block';
  positionHistoryPanel();
  loadHistoryData();
}

function hideHistoryPanel() {
  historyPanel.style.display = 'none';
}

function positionHistoryPanel() {
  const historyBtn = toolbarEl.querySelector('[data-action="history"]') as HTMLButtonElement;
  const btnRect = historyBtn.getBoundingClientRect();
  const panelWidth = 360;
  const gap = 12;

  let left = btnRect.left + btnRect.width / 2 - panelWidth / 2;
  const top = btnRect.top - gap;

  if (left + panelWidth > window.innerWidth - 8) left = window.innerWidth - panelWidth - 8;
  if (left < 8) left = 8;

  historyPanel.style.left = `${left}px`;
  historyPanel.style.top = 'auto';
  historyPanel.style.bottom = `${window.innerHeight - top}px`;
}

function loadHistoryData() {
  const body = historyPanel.querySelector('.history-body') as HTMLDivElement;

  chrome.storage.local.get('funnyHistory', (result) => {
    const history = (result.funnyHistory ?? []) as any[];

    if (history.length === 0) {
      body.innerHTML = '<div class="history-empty">No annotations sent yet</div>';
      return;
    }

    body.innerHTML = '';
    history.forEach((entry) => {
      const item = createElement('div', 'history-item');

      const timeAgo = formatTimeAgo(entry.timestamp);
      const prompts: string[] = (entry.annotations || []).map((a: any) => a.prompt).filter(Boolean);

      let promptsHtml = '';
      if (prompts.length > 0) {
        promptsHtml = `<div class="history-item-prompts">${prompts
          .slice(0, 3)
          .map((p) => `<div class="history-item-prompt">${escapeHtml(p.slice(0, 80))}</div>`)
          .join(
            '',
          )}${prompts.length > 3 ? `<div class="history-item-prompt">+${prompts.length - 3} more</div>` : ''}</div>`;
      }

      item.innerHTML = `
        <div class="history-item-header">
          <span class="history-item-title">${escapeHtml(entry.title || 'Untitled')}</span>
          <span class="history-item-count">${entry.annotationCount} ann.</span>
        </div>
        <div class="history-item-url">${escapeHtml(entry.url || '')}</div>
        ${promptsHtml}
        <div class="history-item-time">${timeAgo}</div>
      `;

      // Click to open thread in Funny if threadId exists
      if (entry.threadId && entry.serverUrl) {
        item.title = 'Open thread in Funny';
        item.addEventListener('click', () => {
          window.open(`${entry.serverUrl}?thread=${entry.threadId}`, '_blank');
        });
      }

      body.appendChild(item);
    });
  });
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Generate markdown output
// ---------------------------------------------------------------------------
function generateMarkdown(): string {
  if (annotations.length === 0) return '';

  // -- User instructions first (clear, top-level) --
  const instructions = annotations
    .map((ann, i) =>
      ann.prompt ? `${annotations.length > 1 ? `${i + 1}. ` : ''}${ann.prompt}` : null,
    )
    .filter(Boolean);

  let md = '';
  if (instructions.length > 0) {
    md += instructions.join('\n') + '\n\n';
  }

  // -- UI context as supporting reference --
  md += `<details>\n<summary>UI Context: ${window.location.href}</summary>\n\n`;
  md += `**Page title:** ${document.title}\n`;
  md += `**Viewport:** ${window.innerWidth}x${window.innerHeight}\n`;
  md += `**Date:** ${new Date().toISOString()}\n\n`;

  annotations.forEach((ann, i) => {
    md += `### Annotated element ${i + 1}`;
    if (ann.elements.length > 1) md += ` (${ann.elements.length} elements)`;
    md += `\n\n`;

    ann.elements.forEach((elem, j) => {
      if (ann.elements.length > 1) md += `#### Element ${j + 1}: \`${elem.elementName}\`\n\n`;
      md += `**Element:** \`${elem.element}\` at \`${elem.elementPath}\`\n`;
      md += `**Position:** ${elem.x}% from left, ${elem.y}px from top\n`;
      if (elem.cssClasses) md += `**Classes:** \`${elem.cssClasses}\`\n`;
      if (elem.componentTree) md += `**Component Tree:** \`${elem.componentTree}\`\n`;
      md += `**Styles:** ${elem.computedStyles}\n`;
      md += `**Accessibility:** ${elem.accessibility}\n`;
      md += `**Nearby text:** ${elem.nearbyText}\n`;
      md += `**Bounding box:** ${elem.boundingBox.width}x${elem.boundingBox.height} at (${elem.boundingBox.x}, ${elem.boundingBox.y})\n`;
      if (elem.isFixed) md += `**Fixed position:** yes\n`;
      md += `\n**HTML (truncated):**\n\`\`\`html\n${elem.outerHTML.slice(0, 500)}\n\`\`\`\n\n`;
    });

    if (i < annotations.length - 1) md += `---\n\n`;
  });

  md += `</details>`;

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

  const sendBtn = toolbarEl.querySelector('[data-action="send"]') as HTMLButtonElement;
  sendBtn.classList.add('toolbar-btn-loading');
  sendBtn.setAttribute('disabled', 'true');

  try {
    // Take screenshot
    const screenshot = await captureScreenshot();

    // Serialize annotations (strip _element refs from each element)
    const serialized = annotations.map((ann) => ({
      ...ann,
      elements: ann.elements.map(({ _element, ...rest }) => rest),
    }));

    const markdown = generateMarkdown();

    // Send to background worker
    safeSendMessage(
      {
        type: 'SEND_TO_FUNNY',
        data: {
          url: window.location.href,
          title: document.title,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          annotations: serialized,
          markdown,
          screenshot,
        },
      },
      (response: any) => {
        sendBtn.classList.remove('toolbar-btn-loading');
        sendBtn.removeAttribute('disabled');

        if (response?.success) {
          // Save to history before clearing
          saveToHistory(serialized, response.threadId);

          // Clear all annotations
          annotations = [];
          _annotationCounter = 0;
          clearMultiSelect();
          renderAnnotations();
          updateToolbarCount();

          showToast('Sent to Funny! Thread created.');
        } else {
          showToast(response?.error || 'Failed to send. Is Funny running?', true);
        }
      },
    );
  } catch (err: any) {
    sendBtn.classList.remove('toolbar-btn-loading');
    sendBtn.removeAttribute('disabled');
    showToast(`Error: ${err.message}`, true);
  }
}

// ---------------------------------------------------------------------------
// Annotation history
// ---------------------------------------------------------------------------
function saveToHistory(serializedAnnotations: any[], threadId?: string) {
  const entry: any = {
    id: `hist_${Date.now()}`,
    timestamp: Date.now(),
    url: window.location.href,
    title: document.title,
    threadId: threadId || null,
    annotationCount: serializedAnnotations.length,
    annotations: serializedAnnotations,
  };

  safeSendMessage({ type: 'GET_CONFIG' }, (config: any) => {
    const serverUrl = config?.serverUrl || 'http://localhost:3001';
    entry.serverUrl = serverUrl;

    // Store in chrome.storage.local (keep last 50 entries)
    chrome.storage.local.get('funnyHistory', (result) => {
      const history = (result.funnyHistory ?? []) as any[];
      history.unshift(entry);
      if (history.length > 50) history.length = 50;
      chrome.storage.local.set({ funnyHistory: history });
    });
  });
}

function captureScreenshot(): Promise<string | null> {
  return new Promise((resolve) => {
    safeSendMessage({ type: 'CAPTURE_SCREENSHOT' }, (response: any) => {
      resolve(response?.screenshot || null);
    });
  });
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
function showToast(message: string, isError = false) {
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
function onMouseMove(e: MouseEvent) {
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

function onClick(e: MouseEvent) {
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

  // Ctrl+click (or Cmd+click on Mac): toggle element in/out of multi-selection
  if (e.ctrlKey || e.metaKey) {
    const idx = multiSelectElements.indexOf(el);
    if (idx >= 0) {
      multiSelectElements.splice(idx, 1);
    } else {
      multiSelectElements.push(el);
    }
    renderMultiSelectHighlights();
    hideHoverHighlight();
    return;
  }

  // Normal click with pending multi-selection → open popover for all
  if (multiSelectElements.length > 0) {
    // Add the clicked element too if not already selected
    if (!multiSelectElements.includes(el)) {
      multiSelectElements.push(el);
      renderMultiSelectHighlights();
    }
    showPopoverForMultiSelect(e.clientX, e.clientY);
    return;
  }

  // Single element annotation (existing behavior)
  showPopoverForElement(el, e.clientX, e.clientY);
}

function onKeyDown(e: KeyboardEvent) {
  if (!isActive) return;
  if (e.key === 'Escape') {
    if (historyPanel.style.display === 'block') {
      hideHistoryPanel();
    } else if (settingsPanel.style.display === 'block') {
      hideSettingsPanel();
    } else if (popover.style.display === 'block') {
      hidePopover();
    } else if (multiSelectElements.length > 0) {
      clearMultiSelect();
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
  toolbarEl.style.display = 'flex';

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
  document.addEventListener('mousemove', dragMoveHandler!);
  document.addEventListener('mouseup', dragUpHandler!);

  renderAnnotations();
  updateToolbarCount();
  loadToolbarProjectName();
}

function deactivate() {
  isActive = false;
  hideHoverHighlight();
  hidePopover();
  hideSettingsPanel();
  hideHistoryPanel();
  clearMultiSelect();
  toolbarEl.style.display = 'none';
  highlightContainer.innerHTML = '';
  badgeContainer.innerHTML = '';
  annotationOverlays = [];

  document.removeEventListener('mousemove', onMouseMove, true);
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('scroll', onScrollOrResize, true);
  window.removeEventListener('resize', onScrollOrResize, true);
  document.removeEventListener('mousemove', dragMoveHandler!);
  document.removeEventListener('mouseup', dragUpHandler!);

  // Cancel any pending rAF
  if (scrollRafId) {
    cancelAnimationFrame(scrollRafId);
    scrollRafId = null;
  }

  // Resume animations if paused
  if (isPaused) {
    document.getAnimations().forEach((a) => a.play());
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
      annotations: annotations.map((ann) => ({
        ...ann,
        elements: ann.elements.map(({ _element, ...rest }) => rest),
      })),
    });
  } else if (msg.type === 'GET_MARKDOWN') {
    sendResponse({ markdown: generateMarkdown() });
  } else if (msg.type === 'CLEAR_ANNOTATIONS') {
    annotations = [];
    _annotationCounter = 0;
    clearMultiSelect();
    renderAnnotations();
    updateToolbarCount();
    sendResponse({ success: true });
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
function safeSendMessage(msg: any, callback?: (response: any) => void) {
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
  } catch {
    runtimeDisconnected = true;
  }
}

// ---------------------------------------------------------------------------
// Styles (loaded from external content.css)
// ---------------------------------------------------------------------------
async function loadStyles(): Promise<string> {
  try {
    const url = chrome.runtime.getURL('content.css');
    const res = await fetch(url);
    return await res.text();
  } catch {
    return ''; // Styles will be missing but extension won't crash
  }
}
