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

import { registerContentActions } from './content/actions';
import { createElement, loadStyles, safeSendMessage } from './content/dom';
import { clearDrawing, createDrawToolbar, toggleDrawMode } from './content/drawing';
import { createHistoryPanel, hideHistoryPanel } from './content/history';
import {
  clearMultiSelect,
  hideHoverHighlight,
  onScrollOrResize,
  renderAnnotations,
  renderMultiSelectHighlights,
  showHoverHighlight,
} from './content/overlays';
import {
  createPopover,
  hidePopover,
  positionPopoverAtPoint,
  showPopoverForEdit,
  showPopoverForElement,
  showPopoverForMultiSelect,
} from './content/popover';
import { copyScreenshotToClipboard, generateMarkdown, sendToFunny } from './content/send';
import { createSettingsPanel, hideSettingsPanel } from './content/settings';
import { st } from './content/state';
import { clearTestIdLabels } from './content/testid-labels';
import {
  createToolbar,
  loadToolbarProjectName,
  toggleBrowseMode,
  updateToolbarCount,
  updateToolbarProjectName,
} from './content/toolbar';

// ---------------------------------------------------------------------------
// Prevent double-injection
// ---------------------------------------------------------------------------
if (window.__funnyAnnotatorActive) {
  // Already injected — bail out. esbuild IIFE wraps this in an arrow
  // function so `return` is valid here (it exits the IIFE, not the module).
  throw new Error('Funny Annotator already active');
}
window.__funnyAnnotatorActive = true;

console.info('[Funny Annotator] v2.1 loaded', new Date().toISOString());

// ---------------------------------------------------------------------------
// Shadow DOM setup
// ---------------------------------------------------------------------------
async function createShadowHost() {
  st.shadowHost = document.createElement('div');
  st.shadowHost.id = 'funny-annotator-host';
  st.shadowHost.style.cssText =
    'all:initial; position:fixed; top:0; left:0; width:0; height:0; z-index:2147483647; pointer-events:none;';
  document.documentElement.appendChild(st.shadowHost);
  st.shadowRoot = st.shadowHost.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = await loadStyles();
  st.shadowRoot.appendChild(style);

  // Containers
  st.highlightContainer = createElement('div', 'highlight-container');
  st.badgeContainer = createElement('div', 'badge-container');
  st.multiSelectContainer = createElement('div', 'multi-select-container');
  st.shadowRoot.appendChild(st.highlightContainer);
  st.shadowRoot.appendChild(st.badgeContainer);
  st.shadowRoot.appendChild(st.multiSelectContainer);

  // Hover highlight
  st.hoverHighlight = createElement('div', 'hover-highlight');
  st.hoverLabel = createElement('div', 'hover-label');
  st.hoverHighlight.appendChild(st.hoverLabel);
  st.shadowRoot.appendChild(st.hoverHighlight);

  // Popover (hidden by default)
  st.popover = createPopover();
  st.shadowRoot.appendChild(st.popover);

  // Settings panel (hidden by default, positioned above toolbar)
  st.settingsPanel = createSettingsPanel();
  st.shadowRoot.appendChild(st.settingsPanel);

  // History panel (hidden by default)
  st.historyPanel = createHistoryPanel();
  st.shadowRoot.appendChild(st.historyPanel);

  // Test ID labels container
  st.testIdContainer = createElement('div', 'testid-container');
  st.shadowRoot.appendChild(st.testIdContainer);

  // Drawing canvas (full-screen, hidden by default)
  st.drawingCanvas = document.createElement('canvas');
  st.drawingCanvas.className = 'drawing-canvas';
  st.drawingCanvas.style.display = 'none';
  st.shadowRoot.appendChild(st.drawingCanvas);
  st.drawingCtx = st.drawingCanvas.getContext('2d')!;

  // Drawing toolbar (color picker + prompt + clear)
  st.drawToolbar = createDrawToolbar();
  st.shadowRoot.appendChild(st.drawToolbar);

  // Toolbar
  st.toolbarEl = createToolbar();
  st.shadowRoot.appendChild(st.toolbarEl);
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------
function onMouseMove(e: MouseEvent) {
  if (!st.isActive || st.isBrowsing || st.isDrawing || st.popover.style.display === 'block') return;

  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el || el === st.shadowHost || st.shadowHost.contains(el)) {
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
  if (!st.isActive) return;

  // Ignore clicks on our own UI (use composedPath to reliably cross shadow DOM boundaries)
  if (e.composedPath().includes(st.shadowHost)) return;

  // In browse mode or draw mode, let clicks pass through / be handled by canvas
  if (st.isBrowsing || st.isDrawing) return;

  // Close settings panel if open
  if (st.settingsPanel.style.display === 'block') {
    hideSettingsPanel();
    return;
  }

  // Ignore if popover is open
  if (st.popover.style.display === 'block') {
    hidePopover();
    return;
  }

  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el || el === document.documentElement || el === document.body) return;

  e.preventDefault();
  e.stopPropagation();

  // Ctrl+click (or Cmd+click on Mac): toggle element in/out of multi-selection
  if (e.ctrlKey || e.metaKey) {
    const idx = st.multiSelectElements.indexOf(el);
    if (idx >= 0) {
      st.multiSelectElements.splice(idx, 1);
    } else {
      st.multiSelectElements.push(el);
    }
    renderMultiSelectHighlights();
    hideHoverHighlight();
    return;
  }

  // Normal click with pending multi-selection → open popover for all
  if (st.multiSelectElements.length > 0) {
    // Add the clicked element too if not already selected
    if (!st.multiSelectElements.includes(el)) {
      st.multiSelectElements.push(el);
      renderMultiSelectHighlights();
    }
    showPopoverForMultiSelect(e.clientX, e.clientY);
    return;
  }

  // Single element annotation (existing behavior)
  showPopoverForElement(el, e.clientX, e.clientY);
}

function onKeyDown(e: KeyboardEvent) {
  if (!st.isActive) return;
  if (e.key === 'Escape') {
    if (st.isDrawing) {
      toggleDrawMode();
    } else if (st.historyPanel.style.display === 'block') {
      hideHistoryPanel();
    } else if (st.settingsPanel.style.display === 'block') {
      hideSettingsPanel();
    } else if (st.popover.style.display === 'block') {
      hidePopover();
    } else if (st.multiSelectElements.length > 0) {
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
  if (st.isActive) return;
  st.isActive = true;
  if (!st.shadowHost) await createShadowHost();
  st.toolbarEl.style.display = 'flex';

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
  document.addEventListener('mousemove', st.dragMoveHandler!);
  document.addEventListener('mouseup', st.dragUpHandler!);

  renderAnnotations();
  updateToolbarCount();
  loadToolbarProjectName();
}

function deactivate() {
  st.isActive = false;
  hideHoverHighlight();
  hidePopover();
  hideSettingsPanel();
  hideHistoryPanel();
  clearMultiSelect();
  st.toolbarEl.style.display = 'none';
  st.highlightContainer.innerHTML = '';
  st.badgeContainer.innerHTML = '';
  st.annotationOverlays = [];

  document.removeEventListener('mousemove', onMouseMove, true);
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('scroll', onScrollOrResize, true);
  window.removeEventListener('resize', onScrollOrResize, true);
  document.removeEventListener('mousemove', st.dragMoveHandler!);
  document.removeEventListener('mouseup', st.dragUpHandler!);

  // Cancel any pending rAF
  if (st.scrollRafId) {
    cancelAnimationFrame(st.scrollRafId);
    st.scrollRafId = null;
  }

  // Exit draw mode if active
  if (st.isDrawing) toggleDrawMode();
  clearDrawing();

  // Clear test-id labels if visible
  if (st.testIdLabelsVisible) {
    st.testIdLabelsVisible = false;
    clearTestIdLabels();
  }

  // Resume animations if paused
  if (st.isPaused) {
    document.getAnimations().forEach((a) => a.play());
    st.isPaused = false;
  }
  st.isBrowsing = false;
}

// ---------------------------------------------------------------------------
// Message listener (from popup or background)
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'TOGGLE_ANNOTATOR') {
    if (st.isActive) {
      deactivate();
    } else {
      activate();
    }
    sendResponse({ active: st.isActive });
  } else if (msg.type === 'GET_STATE') {
    sendResponse({
      active: st.isActive,
      annotationCount: st.annotations.length,
      annotations: st.annotations.map((ann) => ({
        ...ann,
        elements: ann.elements.map(({ domElement: _domElement, ...rest }) => rest),
      })),
    });
  } else if (msg.type === 'GET_MARKDOWN') {
    sendResponse({ markdown: generateMarkdown() });
  } else if (msg.type === 'CLEAR_ANNOTATIONS') {
    st.annotations = [];
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

registerContentActions({
  copyScreenshotToClipboard,
  deactivate,
  hideHistoryPanel,
  hidePopover,
  hideSettingsPanel,
  positionPopoverAtPoint,
  sendToFunny,
  showPopoverForEdit,
  toggleBrowseMode,
  updateToolbarCount,
  updateToolbarProjectName,
});
