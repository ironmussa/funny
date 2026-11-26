/** DOM, messaging and formatting helpers shared by the annotator modules. */

import { st } from './state';

/** An SVG element's `className` is an SVGAnimatedString, not a string. */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

export function formatTimeAgo(ts: number): string {
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

export function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
export function showToast(message: string, isError = false) {
  const existing = st.shadowRoot.querySelector('.toast');
  if (existing) existing.remove();

  const toast = createElement('div', `toast ${isError ? 'toast-error' : ''}`);
  toast.textContent = message;
  st.shadowRoot.appendChild(toast);

  setTimeout(() => toast.classList.add('toast-visible'), 10);
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ---------------------------------------------------------------------------
// Runtime disconnect handler
// ---------------------------------------------------------------------------
// When the extension is updated/reloaded, chrome.runtime becomes invalid.
// Wrap sendMessage calls to avoid "Extension context invalidated" errors.
export function safeSendMessage(msg: any, callback?: (response: any) => void) {
  try {
    if (st.runtimeDisconnected) return;
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        st.runtimeDisconnected = true;
        console.warn('[Funny Annotator] Extension disconnected:', chrome.runtime.lastError.message);
        return;
      }
      if (callback) callback(response);
    });
  } catch {
    st.runtimeDisconnected = true;
  }
}

// ---------------------------------------------------------------------------
// Styles (loaded from external content.css)
// ---------------------------------------------------------------------------
export async function loadStyles(): Promise<string> {
  try {
    const url = chrome.runtime.getURL('content.css');
    const res = await fetch(url);
    return await res.text();
  } catch {
    return ''; // Styles will be missing but extension won't crash
  }
}
