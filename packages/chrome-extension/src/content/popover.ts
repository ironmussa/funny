/** Annotation popover: create, edit and delete annotations. */

import { formatAccessibility } from '@funny/shared/dom/extract';

import { actions } from './actions';
import { createElement, isString, safeSendMessage } from './dom';
import { buildElementData, getComponentTree, getElementName } from './element-info';
import {
  clearMultiSelect,
  hideHoverHighlight,
  renderAnnotations,
  renderMultiSelectHighlights,
} from './overlays';
import { sendToFunny } from './send';
import { st } from './state';
import type { Annotation } from './types';

// ---------------------------------------------------------------------------
// Popover (annotation form)
// ---------------------------------------------------------------------------

function resetDetailsCollapsed() {
  const body = st.popover.querySelector<HTMLDivElement>('.popover-details-body');
  const arrow = st.popover.querySelector<SVGElement>('.popover-details-arrow');
  if (body) body.style.display = 'none';
  if (arrow) arrow.classList.remove('popover-details-arrow-open');
}

function loadPopoverProjectName() {
  safeSendMessage({ type: 'GET_CONFIG' }, (config: any) => {
    const currentUrl = window.location.href;

    // Ask the server to resolve the project by URL
    safeSendMessage({ type: 'RESOLVE_PROJECT', url: currentUrl }, (result: any) => {
      if (result?.success && result.project && result.source === 'url_match') {
        // Auto-select the matched project if it differs from current config
        if (config?.projectId !== result.project.id) {
          safeSendMessage({
            type: 'SAVE_CONFIG',
            config: { ...config, projectId: result.project.id },
          });
        }
        st.popoverProjectName.textContent = result.project.name;
        st.popoverProjectName.classList.remove('popover-project-empty');
        return;
      }

      // No URL match — fall back to the user's manually-selected project
      if (!config?.projectId) {
        st.popoverProjectName.textContent = 'No project';
        st.popoverProjectName.classList.add('popover-project-empty');
        return;
      }

      // Fetch projects to resolve the name of the configured project
      safeSendMessage({ type: 'FETCH_PROJECTS' }, (projResult: any) => {
        if (!projResult?.success || !projResult.projects) {
          st.popoverProjectName.textContent = 'No project';
          st.popoverProjectName.classList.add('popover-project-empty');
          return;
        }
        const project = projResult.projects.find((p: any) => p.id === config.projectId);
        st.popoverProjectName.textContent = project?.name || 'No project';
        st.popoverProjectName.classList.toggle('popover-project-empty', !project);
      });
    });
  });
}

export function createPopover(): HTMLDivElement {
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
  st.popoverTextarea = pop.querySelector<HTMLTextAreaElement>('.popover-textarea')!;
  st.popoverError = pop.querySelector<HTMLDivElement>('.popover-error')!;
  st.popoverElementName = pop.querySelector<HTMLSpanElement>('.popover-element-name')!;
  st.popoverElementList = pop.querySelector<HTMLDivElement>('.popover-element-list')!;
  st.popoverAddBtn = pop.querySelector<HTMLButtonElement>('.popover-add')!;
  st.popoverDeleteBtn = pop.querySelector<HTMLButtonElement>('.popover-delete')!;
  st.popoverProjectName = pop.querySelector<HTMLSpanElement>('.popover-project-name')!;
  st.popoverSendBtn = pop.querySelector<HTMLButtonElement>('.popover-send-btn')!;

  // Send to Funny from popover
  st.popoverSendBtn.addEventListener('click', () => {
    // First add the current annotation, then send all
    addAnnotationFromPopover();
    if (st.annotations.length > 0) {
      sendToFunny();
    }
  });

  // Element name toggles details
  const elementToggle = pop.querySelector<HTMLButtonElement>('.popover-element-toggle')!;
  const detailsBody = pop.querySelector<HTMLDivElement>('.popover-details-body')!;
  const detailsArrow = pop.querySelector<SVGElement>('.popover-details-arrow')!;
  elementToggle.addEventListener('click', () => {
    const open = detailsBody.style.display !== 'none';
    detailsBody.style.display = open ? 'none' : 'block';
    detailsArrow.classList.toggle('popover-details-arrow-open', !open);
  });

  // Events
  pop.querySelector('.popover-cancel')!.addEventListener('click', () => hidePopover());
  pop.querySelector('.popover-close-btn')!.addEventListener('click', () => hidePopover());
  st.popoverAddBtn.addEventListener('click', () => addAnnotationFromPopover());
  st.popoverDeleteBtn.addEventListener('click', () => deleteAnnotationFromPopover());

  // Clear validation error on input
  st.popoverTextarea.addEventListener('input', () => {
    if (st.popoverTextarea.value.trim()) {
      st.popoverTextarea.classList.remove('popover-textarea-error');
      st.popoverError.style.display = 'none';
    }
  });

  // Enter to submit
  st.popoverTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      addAnnotationFromPopover();
    }
  });

  return pop;
}

function populateElementDetails(el: Element) {
  const tag = el.tagName.toLowerCase();
  const classes = (isString(el.className) ? el.className : '').trim();
  const component = getComponentTree(el);
  const a11y = formatAccessibility(el);

  // Selector
  st.popover.querySelector<HTMLElement>('.popover-detail-selector')!.textContent =
    tag + (el.id ? `#${el.id}` : '');

  // Classes
  const classesEl = st.popover.querySelector<HTMLElement>('.popover-detail-classes')!;
  classesEl.textContent = classes || 'none';

  // Component tree (only show if detected)
  const compRow = st.popover.querySelector<HTMLDivElement>('.popover-detail-component-row')!;
  if (component) {
    compRow.style.display = '';
    st.popover.querySelector<HTMLElement>('.popover-detail-component')!.textContent = component;
  } else {
    compRow.style.display = 'none';
  }

  // Computed styles as individual rows
  const stylesContainer = st.popover.querySelector<HTMLDivElement>('.popover-detail-styles')!;
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
  const a11yRow = st.popover.querySelector<HTMLDivElement>('.popover-detail-a11y-row')!;
  if (a11y && a11y !== 'none') {
    a11yRow.style.display = '';
    st.popover.querySelector<HTMLElement>('.popover-detail-a11y')!.textContent = a11y;
  } else {
    a11yRow.style.display = 'none';
  }
}

export function showPopoverForElement(el: Element, clickX: number, clickY: number) {
  st.pendingAnnotationElement = el;
  st.editingAnnotationIndex = -1;
  st.pendingMultiSelectElements = null;

  st.popoverElementName.textContent = getElementName(el);
  st.popoverElementList.style.display = 'none';
  st.popoverElementList.innerHTML = '';
  st.popoverTextarea.value = '';
  st.popoverTextarea.placeholder = 'What should be done with this element?';
  st.popoverTextarea.classList.remove('popover-textarea-error');
  st.popoverError.style.display = 'none';
  st.popoverAddBtn.textContent = 'Add';
  st.popoverDeleteBtn.style.display = 'none';
  resetDetailsCollapsed();
  const header = st.popover.querySelector<HTMLDivElement>('.popover-header');
  if (header) header.style.display = '';
  populateElementDetails(el);

  loadPopoverProjectName();
  positionPopoverAtPoint(clickX, clickY);
  st.popover.style.display = 'block';
  st.popoverTextarea.focus();
}

export function showPopoverForEdit(ann: Annotation, index: number, clickX: number, clickY: number) {
  st.editingAnnotationIndex = index;
  st.popoverTextarea.value = ann.prompt;
  st.popoverTextarea.classList.remove('popover-textarea-error');
  st.popoverError.style.display = 'none';
  st.popoverAddBtn.textContent = 'Update';
  st.popoverDeleteBtn.style.display = 'inline-block';

  if (ann.elements.length > 1) {
    // Multi-element annotation: show chips, hide details
    st.pendingAnnotationElement = null;
    st.pendingMultiSelectElements = ann.elements.map((e) => e.domElement);
    st.popoverElementName.textContent = `${ann.elements.length} elements selected`;
    st.popoverTextarea.placeholder = 'What should be done with these elements?';
    st.popoverElementList.innerHTML = '';
    st.popoverElementList.style.display = 'flex';
    ann.elements.forEach((elemData) => {
      const chip = createElement('span', 'popover-element-chip');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = elemData.elementName;
      nameSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
      chip.appendChild(nameSpan);
      st.popoverElementList.appendChild(chip);
    });
    const header = st.popover.querySelector<HTMLDivElement>('.popover-header');
    if (header) header.style.display = 'none';
  } else {
    // Single-element annotation
    const elemData = ann.elements[0];
    st.pendingAnnotationElement = elemData.domElement;
    st.pendingMultiSelectElements = null;
    st.popoverElementName.textContent = elemData.elementName;
    st.popoverTextarea.placeholder = 'What should be done with this element?';
    st.popoverElementList.style.display = 'none';
    st.popoverElementList.innerHTML = '';
    resetDetailsCollapsed();
    const header = st.popover.querySelector<HTMLDivElement>('.popover-header');
    if (header) header.style.display = '';
    populateElementDetails(elemData.domElement);
  }

  loadPopoverProjectName();
  positionPopoverAtPoint(clickX, clickY);
  st.popover.style.display = 'block';
  st.popoverTextarea.focus();
}

export function showPopoverForMultiSelect(clickX: number, clickY: number) {
  st.pendingAnnotationElement = null;
  st.editingAnnotationIndex = -1;
  st.pendingMultiSelectElements = [...st.multiSelectElements];

  // Header shows count
  st.popoverElementName.textContent = `${st.pendingMultiSelectElements.length} elements selected`;

  // Populate chip list
  st.popoverElementList.innerHTML = '';
  st.popoverElementList.style.display = 'flex';
  st.pendingMultiSelectElements.forEach((el, i) => {
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
    st.popoverElementList.appendChild(chip);
  });

  st.popoverTextarea.value = '';
  st.popoverTextarea.placeholder = 'What should be done with these elements?';
  st.popoverTextarea.classList.remove('popover-textarea-error');
  st.popoverError.style.display = 'none';
  st.popoverAddBtn.textContent = 'Add';
  st.popoverDeleteBtn.style.display = 'none';

  // Hide element header (not useful for multi-select, chips are shown instead)
  const header = st.popover.querySelector<HTMLDivElement>('.popover-header');
  if (header) header.style.display = 'none';

  loadPopoverProjectName();
  positionPopoverAtPoint(clickX, clickY);
  st.popover.style.display = 'block';
  st.popoverTextarea.focus();
}

function removeFromMultiSelect(index: number) {
  if (!st.pendingMultiSelectElements) return;

  // Remove from pending list
  st.pendingMultiSelectElements.splice(index, 1);

  // Also remove from the live multi-select array
  st.multiSelectElements = [...st.pendingMultiSelectElements];
  renderMultiSelectHighlights();

  if (st.pendingMultiSelectElements.length === 0) {
    // No elements left, close popover
    hidePopover();
    return;
  }

  // Re-render chips
  st.popoverElementName.textContent = `${st.pendingMultiSelectElements.length} elements selected`;
  st.popoverElementList.innerHTML = '';
  st.pendingMultiSelectElements.forEach((el, i) => {
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
    st.popoverElementList.appendChild(chip);
  });
}

export function positionPopoverAtPoint(x: number, y: number) {
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

  st.popover.style.top = `${top}px`;
  st.popover.style.left = `${left}px`;
}

export function hidePopover() {
  st.popover.style.display = 'none';
  st.pendingAnnotationElement = null;
  st.editingAnnotationIndex = -1;
  st.pendingMultiSelectElements = null;
  hideHoverHighlight();
  // Clear multi-select visuals if popover is dismissed
  if (st.multiSelectElements.length > 0) {
    clearMultiSelect();
  }
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
  const prompt = st.popoverTextarea.value.trim();

  // Validate: prompt is required
  if (!prompt) {
    st.popoverTextarea.classList.add('popover-textarea-error');
    st.popoverError.style.display = 'block';
    st.popoverTextarea.focus();
    return;
  }

  // Editing an existing annotation (single or multi-element)
  if (st.editingAnnotationIndex >= 0) {
    const existing = st.annotations[st.editingAnnotationIndex];
    const elements = existing.elements.map((e) => e.domElement);
    st.annotations[st.editingAnnotationIndex] = buildAnnotation(prompt, elements);
  } else if (st.pendingMultiSelectElements && st.pendingMultiSelectElements.length > 0) {
    // New multi-select annotation
    st.annotations.push(buildAnnotation(prompt, st.pendingMultiSelectElements));
    clearMultiSelect();
  } else {
    // New single-element annotation
    const el = st.pendingAnnotationElement;
    if (!el) return;
    st.annotations.push(buildAnnotation(prompt, [el]));
  }

  hidePopover();
  renderAnnotations();
  actions().updateToolbarCount();
}

function deleteAnnotationFromPopover() {
  if (st.editingAnnotationIndex >= 0) {
    st.annotations.splice(st.editingAnnotationIndex, 1);
  }
  hidePopover();
  renderAnnotations();
  actions().updateToolbarCount();
}
