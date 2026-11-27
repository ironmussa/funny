/**
 * Whether a freshly created prompt editor may take focus.
 *
 * Several prompt editors can live on screen at once (the grid's columns, a
 * compose cell, plan / question cards). A column remounts its editor when its
 * thread finishes, and an unconditional autofocus would move the caret out of
 * the field the user is typing in, so their next keystrokes land in the other
 * thread's follow-up. Take focus only when no other text field holds it.
 */
export function canAutofocusEditor(
  editorDom: Element,
  active: Element | null = typeof document === 'undefined' ? null : document.activeElement,
): boolean {
  if (!active || editorDom.contains(active)) return true;
  return !isTextEntry(active);
}

function isTextEntry(el: Element): boolean {
  if (el.closest('[contenteditable]:not([contenteditable="false"])')) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    return !NON_TEXT_INPUTS.has(el.type);
  }
  return false;
}

const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'radio',
  'submit',
  'reset',
  'file',
  'image',
  'range',
  'color',
]);
