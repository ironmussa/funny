/** Drawing mode: canvas, drawing toolbar and strokes. */

import { actions } from './actions';
import { createElement, showToast } from './dom';
import { clearMultiSelect, hideHoverHighlight } from './overlays';
import { st } from './state';

const DRAW_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#ffffff'] as const;

// ---------------------------------------------------------------------------
// Drawing mode
// ---------------------------------------------------------------------------
export function createDrawToolbar(): HTMLDivElement {
  const bar = createElement('div', 'draw-toolbar');
  bar.style.display = 'none';

  // Drag handle (grip dots)
  const dragHandle = createElement('div', 'draw-toolbar-drag');
  dragHandle.innerHTML = `<svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor">
    <circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/>
    <circle cx="2" cy="7" r="1.2"/><circle cx="6" cy="7" r="1.2"/>
    <circle cx="2" cy="12" r="1.2"/><circle cx="6" cy="12" r="1.2"/>
  </svg>`;
  dragHandle.title = 'Drag to move';
  bar.appendChild(dragHandle);

  // Separator before colors
  bar.appendChild(createElement('div', 'draw-toolbar-sep'));

  // Color swatches
  const colors = createElement('div', 'draw-colors');
  DRAW_COLORS.forEach((color) => {
    const swatch = createElement('button', 'draw-color-swatch');
    swatch.style.background = color;
    swatch.dataset.color = color;
    if (color === st.drawColor) swatch.classList.add('draw-color-active');
    if (color === '#ffffff') swatch.style.border = '1px solid #666';
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      st.drawColor = color;
      st.drawingCtx.strokeStyle = color;
      bar
        .querySelectorAll('.draw-color-swatch')
        .forEach((s) => s.classList.remove('draw-color-active'));
      swatch.classList.add('draw-color-active');
    });
    colors.appendChild(swatch);
  });
  bar.appendChild(colors);

  // Separator
  const sep = createElement('div', 'draw-toolbar-sep');
  bar.appendChild(sep);

  // Clear drawing button
  const clearBtn = createElement('button', 'draw-clear-btn');
  clearBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polyline points="3 6 5 6 21 6"></polyline>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
  </svg>`;
  clearBtn.title = 'Clear drawing';
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!st.hasDrawingContent) return;
    clearDrawing();
    showToast('Drawing cleared');
  });
  bar.appendChild(clearBtn);

  // Copy screenshot button
  const copyBtn = createElement('button', 'draw-copy-btn');
  copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
  </svg>`;
  copyBtn.title = 'Copy screenshot to clipboard';
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    actions().copyScreenshotToClipboard();
  });
  bar.appendChild(copyBtn);

  // Separator
  const sep2 = createElement('div', 'draw-toolbar-sep');
  bar.appendChild(sep2);

  // Prompt input
  st.drawPromptInput = createElement('textarea', 'draw-prompt-input');
  st.drawPromptInput.placeholder = 'Describe what you want to change...';
  st.drawPromptInput.rows = 1;
  st.drawPromptInput.addEventListener('keydown', (e) => {
    e.stopPropagation(); // Don't trigger Escape/other hotkeys while typing
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      actions().sendToFunny();
    }
  });
  bar.appendChild(st.drawPromptInput);

  // Send button
  const sendBtn = createElement('button', 'draw-send-btn');
  sendBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <line x1="22" y1="2" x2="11" y2="13"></line>
    <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
  </svg>`;
  sendBtn.title = 'Send drawing + prompt to Funny';
  sendBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    actions().sendToFunny();
  });
  bar.appendChild(sendBtn);

  // Separator before close
  bar.appendChild(createElement('div', 'draw-toolbar-sep'));

  // Close button (same style as main toolbar close)
  const closeBtn = createElement('button', 'toolbar-btn draw-toolbar-close');
  closeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <line x1="18" y1="6" x2="6" y2="18"></line>
    <line x1="6" y1="6" x2="18" y2="18"></line>
  </svg>`;
  closeBtn.title = 'Close draw mode';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDrawMode();
  });
  bar.appendChild(closeBtn);

  // --- Drag logic ---
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  const onDragMove = (e: MouseEvent) => {
    if (!isDragging) return;
    const x = e.clientX - dragOffsetX;
    const y = e.clientY - dragOffsetY;
    bar.style.left = `${x}px`;
    bar.style.top = `${y}px`;
    bar.style.transform = 'none';
  };

  const onDragEnd = () => {
    isDragging = false;
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
  };

  dragHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    isDragging = true;
    const rect = bar.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
  });

  return bar;
}

export function toggleDrawMode() {
  st.isDrawing = !st.isDrawing;
  const btn = st.toolbarEl.querySelector<HTMLButtonElement>('[data-action="draw"]')!;

  if (st.isDrawing) {
    // Exit browse mode if active
    if (st.isBrowsing) actions().toggleBrowseMode();
    hideHoverHighlight();
    actions().hidePopover();
    clearMultiSelect();

    btn.classList.add('toolbar-btn-draw-active');
    btn.title = 'Exit draw mode';

    // Size canvas to full viewport
    st.drawingCanvas.width = window.innerWidth;
    st.drawingCanvas.height = window.innerHeight;
    st.drawingCanvas.style.display = 'block';

    // Restore existing strokes if any
    if (!st.hasDrawingContent) {
      st.drawingCtx.clearRect(0, 0, st.drawingCanvas.width, st.drawingCanvas.height);
    }

    // Set up drawing style
    st.drawingCtx.strokeStyle = st.drawColor;
    st.drawingCtx.lineWidth = 3;
    st.drawingCtx.lineCap = 'round';
    st.drawingCtx.lineJoin = 'round';

    // Show draw toolbar (reset position to center)
    st.drawToolbar.style.left = '50%';
    st.drawToolbar.style.top = '16px';
    st.drawToolbar.style.transform = 'translateX(-50%)';
    st.drawToolbar.style.display = 'flex';

    // Attach drawing listeners on canvas
    st.drawingCanvas.addEventListener('mousedown', onDrawStart);
    st.drawingCanvas.addEventListener('mousemove', onDrawMove);
    st.drawingCanvas.addEventListener('mouseup', onDrawEnd);
    st.drawingCanvas.addEventListener('mouseleave', onDrawEnd);
    // Touch support
    st.drawingCanvas.addEventListener('touchstart', onDrawTouchStart, { passive: false });
    st.drawingCanvas.addEventListener('touchmove', onDrawTouchMove, { passive: false });
    st.drawingCanvas.addEventListener('touchend', onDrawEnd);
  } else {
    btn.classList.remove('toolbar-btn-draw-active');
    btn.title = 'Draw on screen';
    st.drawingCanvas.style.display = 'none';
    st.drawToolbar.style.display = 'none';

    st.drawingCanvas.removeEventListener('mousedown', onDrawStart);
    st.drawingCanvas.removeEventListener('mousemove', onDrawMove);
    st.drawingCanvas.removeEventListener('mouseup', onDrawEnd);
    st.drawingCanvas.removeEventListener('mouseleave', onDrawEnd);
    st.drawingCanvas.removeEventListener('touchstart', onDrawTouchStart);
    st.drawingCanvas.removeEventListener('touchmove', onDrawTouchMove);
    st.drawingCanvas.removeEventListener('touchend', onDrawEnd);
  }
}

function onDrawStart(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  st.isDrawingStroke = true;
  st.hasDrawingContent = true;
  st.drawingCtx.beginPath();
  st.drawingCtx.moveTo(e.offsetX, e.offsetY);
}

function onDrawMove(e: MouseEvent) {
  if (!st.isDrawingStroke) return;
  e.preventDefault();
  e.stopPropagation();
  st.drawingCtx.lineTo(e.offsetX, e.offsetY);
  st.drawingCtx.stroke();
}

function onDrawEnd(e: MouseEvent | TouchEvent) {
  if (st.isDrawingStroke) {
    e.preventDefault();
    st.isDrawingStroke = false;
  }
}

function onDrawTouchStart(e: TouchEvent) {
  e.preventDefault();
  const touch = e.touches[0];
  const rect = st.drawingCanvas.getBoundingClientRect();
  st.isDrawingStroke = true;
  st.hasDrawingContent = true;
  st.drawingCtx.beginPath();
  st.drawingCtx.moveTo(touch.clientX - rect.left, touch.clientY - rect.top);
}

function onDrawTouchMove(e: TouchEvent) {
  if (!st.isDrawingStroke) return;
  e.preventDefault();
  const touch = e.touches[0];
  const rect = st.drawingCanvas.getBoundingClientRect();
  st.drawingCtx.lineTo(touch.clientX - rect.left, touch.clientY - rect.top);
  st.drawingCtx.stroke();
}

export function clearDrawing() {
  st.drawingCtx.clearRect(0, 0, st.drawingCanvas.width, st.drawingCanvas.height);
  st.hasDrawingContent = false;
}

export function getDrawingDataUrl(): string | null {
  if (!st.hasDrawingContent) return null;
  return st.drawingCanvas.toDataURL('image/png');
}
