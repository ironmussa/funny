/** Overlay of `data-testid` labels. */

import { st } from './state';

// ---------------------------------------------------------------------------
// Test ID label overlay
// ---------------------------------------------------------------------------

export function toggleTestIdLabels() {
  st.testIdLabelsVisible = !st.testIdLabelsVisible;
  const btn = st.toolbarEl.querySelector<HTMLButtonElement>('[data-action="show-testids"]')!;

  if (st.testIdLabelsVisible) {
    btn.classList.add('toolbar-btn-active');
    btn.title = 'Hide data-testid labels';
    renderTestIdLabels();
    // Watch for DOM changes to re-render labels
    st.testIdObserver = new MutationObserver(() => {
      if (st.testIdLabelsVisible) renderTestIdLabels();
    });
    st.testIdObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-testid'],
    });
    // Re-position labels on scroll/resize
    st.testIdScrollHandler = () => {
      if (st.testIdLabelsVisible) renderTestIdLabels();
    };
    window.addEventListener('scroll', st.testIdScrollHandler, true);
    window.addEventListener('resize', st.testIdScrollHandler);
  } else {
    btn.classList.remove('toolbar-btn-active');
    btn.title = 'Show data-testid labels';
    clearTestIdLabels();
  }
}

function renderTestIdLabels() {
  st.testIdContainer.innerHTML = '';
  const elements = document.querySelectorAll('[data-testid]');

  elements.forEach((el) => {
    const testId = el.getAttribute('data-testid');
    if (!testId) return;

    const rect = el.getBoundingClientRect();
    // Skip elements that are not visible or have zero size
    if (rect.width === 0 && rect.height === 0) return;

    // Create the label overlay
    const label = document.createElement('div');
    label.className = 'testid-label';
    label.textContent = testId;
    label.title = testId;

    // Position at the top-left corner of the element
    // Clamp max-width to the element's width so labels don't overflow small elements
    label.style.position = 'fixed';
    label.style.left = `${rect.left}px`;
    label.style.top = `${rect.top}px`;
    label.style.maxWidth = `${Math.min(120, rect.width)}px`;
    label.style.pointerEvents = 'none';

    // Create a subtle border highlight around the element
    const highlight = document.createElement('div');
    highlight.className = 'testid-highlight';
    highlight.style.position = 'fixed';
    highlight.style.left = `${rect.left}px`;
    highlight.style.top = `${rect.top}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
    highlight.style.pointerEvents = 'none';

    st.testIdContainer.appendChild(highlight);
    st.testIdContainer.appendChild(label);
  });
}

export function clearTestIdLabels() {
  st.testIdContainer.innerHTML = '';
  if (st.testIdObserver) {
    st.testIdObserver.disconnect();
    st.testIdObserver = null;
  }
  if (st.testIdScrollHandler) {
    window.removeEventListener('scroll', st.testIdScrollHandler, true);
    window.removeEventListener('resize', st.testIdScrollHandler);
    st.testIdScrollHandler = null;
  }
}
