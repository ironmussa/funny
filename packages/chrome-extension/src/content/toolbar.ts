/** Floating toolbar and its actions. */

import { actions } from './actions';
import { createElement, safeSendMessage, showToast } from './dom';
import { clearDrawing, toggleDrawMode } from './drawing';
import { toggleHistoryPanel } from './history';
import { clearMultiSelect, hideHoverHighlight, renderAnnotations } from './overlays';
import { hidePopover } from './popover';
import { copyAsMarkdown, copyScreenshotToClipboard, sendToFunny } from './send';
import { hideSettingsPanel, toggleSettingsPanel } from './settings';
import { st } from './state';
import { toggleTestIdLabels } from './testid-labels';

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------
export function createToolbar(): HTMLDivElement {
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
    <button class="toolbar-btn" data-action="draw" title="Draw on screen">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 19l7-7 3 3-7 7-3-3z"></path>
        <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path>
        <path d="M2 2l7.586 7.586"></path>
        <circle cx="11" cy="11" r="2"></circle>
      </svg>
    </button>
    <button class="toolbar-btn" data-action="toggle-visibility" title="Toggle annotations">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
        <circle cx="12" cy="12" r="3"></circle>
      </svg>
    </button>
    <button class="toolbar-btn" data-action="show-testids" title="Show data-testid labels">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M4 7V4h16v3"></path>
        <path d="M9 20h6"></path>
        <path d="M12 4v16"></path>
      </svg>
    </button>
    <button class="toolbar-btn" data-action="copy" title="Copy as markdown">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
    </button>
    <button class="toolbar-btn" data-action="copy-screenshot" title="Copy screenshot to clipboard">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
        <circle cx="12" cy="13" r="4"></circle>
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
    if (!(e.target instanceof Element)) return;
    const btn = e.target.closest<HTMLElement>('[data-action]');
    if (!btn) return;
    e.stopPropagation();
    handleToolbarAction(btn.dataset.action!);
  });

  // Drag to reposition (only from the drag handle)
  const dragHandle = tb.querySelector<HTMLDivElement>('.toolbar-drag-handle')!;
  dragHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    st.isDragging = true;
    const rect = tb.getBoundingClientRect();
    st.dragOffset.x = e.clientX - rect.left;
    st.dragOffset.y = e.clientY - rect.top;
    tb.classList.add('toolbar-dragging');
    // Close panels so they don't detach visually
    hideSettingsPanel();
    hidePopover();
  });

  // Named handlers so they can be removed on deactivate
  st.dragMoveHandler = (e: MouseEvent) => {
    if (!st.isDragging) return;
    const x = e.clientX - st.dragOffset.x;
    const y = e.clientY - st.dragOffset.y;
    tb.style.left = `${x}px`;
    tb.style.top = `${y}px`;
    tb.style.bottom = 'auto';
    tb.style.transform = 'none';
  };
  st.dragUpHandler = () => {
    if (!st.isDragging) return;
    st.isDragging = false;
    tb.classList.remove('toolbar-dragging');
  };

  return tb;
}

export function updateToolbarCount() {
  const count = st.toolbarEl.querySelector<HTMLSpanElement>('.toolbar-count')!;
  const label = st.toolbarEl.querySelector<HTMLSpanElement>('.toolbar-send-label')!;
  if (st.annotations.length > 0) {
    count.textContent = String(st.annotations.length);
    count.style.display = 'inline-flex';
    label.textContent = `Send (${st.annotations.length})`;
  } else {
    count.style.display = 'none';
    label.textContent = 'Send';
  }
}

export function loadToolbarProjectName() {
  safeSendMessage({ type: 'GET_FULL_CONFIG' }, (data: any) => {
    if (!data?.success) return;
    const config = data.config || {};
    const projects: Array<{ id: string; name: string }> = data.projects || [];
    const project = config.projectId ? projects.find((p) => p.id === config.projectId) : null;
    updateToolbarProjectName(project?.name || '');
  });
}

export function updateToolbarProjectName(name: string) {
  const el = st.toolbarEl.querySelector<HTMLSpanElement>('.toolbar-project');
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
    case 'draw':
      toggleDrawMode();
      break;
    case 'toggle-visibility':
      st.annotationsVisible = !st.annotationsVisible;
      renderAnnotations();
      updateVisibilityButton();
      break;
    case 'show-testids':
      toggleTestIdLabels();
      break;
    case 'copy':
      copyAsMarkdown();
      break;
    case 'copy-screenshot':
      copyScreenshotToClipboard();
      break;
    case 'clear':
      st.annotations = [];
      clearMultiSelect();
      clearDrawing();
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
      actions().deactivate();
      break;
  }
}

function updateVisibilityButton() {
  const btn = st.toolbarEl.querySelector<HTMLButtonElement>('[data-action="toggle-visibility"]')!;
  if (st.annotationsVisible) {
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
  st.isPaused = !st.isPaused;
  const btn = st.toolbarEl.querySelector<HTMLButtonElement>('[data-action="pause"]')!;
  if (st.isPaused) {
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

export function toggleBrowseMode() {
  st.isBrowsing = !st.isBrowsing;
  const btn = st.toolbarEl.querySelector<HTMLButtonElement>('[data-action="browse"]')!;
  if (st.isBrowsing) {
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
