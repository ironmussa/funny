/** Hover highlight, annotation and multi-select overlays, and their repositioning on scroll. */

import { actions } from './actions';
import { createElement } from './dom';
import { getElementName } from './element-info';
import { st } from './state';

// ---------------------------------------------------------------------------
// Hover highlight
// ---------------------------------------------------------------------------
export function showHoverHighlight(el: Element) {
  if (!el || el === st.hoveredElement) return;
  st.hoveredElement = el;
  const rect = el.getBoundingClientRect();
  st.hoverHighlight.style.cssText = `
    position: fixed;
    top: ${rect.top}px;
    left: ${rect.left}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
    display: block;
    pointer-events: none;
  `;
  st.hoverLabel.textContent = getElementName(el);
}

export function hideHoverHighlight() {
  st.hoveredElement = null;
  st.hoverHighlight.style.display = 'none';
}

export function renderAnnotations() {
  // Full rebuild: clears and recreates all overlays.
  // Called when annotations array changes (add/edit/delete/toggle visibility).
  st.annotationOverlays = [];
  st.highlightContainer.innerHTML = '';
  st.badgeContainer.innerHTML = '';

  if (!st.annotationsVisible) return;

  st.annotations.forEach((ann, i) => {
    // Each annotation can have one or more elements
    for (const elemData of ann.elements) {
      const el = elemData.domElement;
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
      st.highlightContainer.appendChild(hl);

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
        actions().showPopoverForEdit(ann, i, e.clientX, e.clientY);
      });
      st.badgeContainer.appendChild(badge);

      st.annotationOverlays.push({ hl, badge, element: el });
    }
  });
}

function repositionAnnotations() {
  // Fast path: move existing overlay DOM nodes without rebuilding.
  for (const { hl, badge, element } of st.annotationOverlays) {
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
export function renderMultiSelectHighlights() {
  st.multiSelectOverlays = [];
  st.multiSelectContainer.innerHTML = '';

  st.multiSelectElements.forEach((el, i) => {
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
    st.multiSelectContainer.appendChild(hl);

    const badge = createElement('div', 'multi-select-badge');
    badge.textContent = String(i + 1);
    badge.style.cssText = `
      position: fixed;
      top: ${rect.top - 10}px;
      left: ${rect.right - 10}px;
      pointer-events: none;
    `;
    st.multiSelectContainer.appendChild(badge);

    st.multiSelectOverlays.push({ hl, badge, element: el });
  });
}

function repositionMultiSelectHighlights() {
  for (const { hl, badge, element } of st.multiSelectOverlays) {
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

export function clearMultiSelect() {
  st.multiSelectElements = [];
  st.multiSelectOverlays = [];
  st.pendingMultiSelectElements = null;
  st.multiSelectContainer.innerHTML = '';
}

// Reposition on scroll/resize (throttled via rAF)
export function onScrollOrResize() {
  if (!st.isActive) return;
  if (st.scrollRafId) return; // already scheduled
  st.scrollRafId = requestAnimationFrame(() => {
    st.scrollRafId = null;
    // Move existing overlays (no DOM rebuild)
    repositionAnnotations();
    repositionMultiSelectHighlights();
    // Update hover highlight position
    if (st.hoveredElement && document.contains(st.hoveredElement)) {
      const rect = st.hoveredElement.getBoundingClientRect();
      st.hoverHighlight.style.top = `${rect.top}px`;
      st.hoverHighlight.style.left = `${rect.left}px`;
      st.hoverHighlight.style.width = `${rect.width}px`;
      st.hoverHighlight.style.height = `${rect.height}px`;
    }
    // Update popover position
    if (
      st.popover.style.display !== 'none' &&
      st.pendingAnnotationElement &&
      document.contains(st.pendingAnnotationElement)
    ) {
      const r = st.pendingAnnotationElement.getBoundingClientRect();
      actions().positionPopoverAtPoint(r.left, r.top);
    }
  });
}
