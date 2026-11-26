/** Annotation history panel and the history kept in chrome.storage.local. */

import { threadUrl } from '../api';
import { actions } from './actions';
import { createElement, escapeHtml, formatTimeAgo, safeSendMessage } from './dom';
import { st } from './state';
import type { FunnyHistoryStorage, HistoryEntry } from './types';

// ---------------------------------------------------------------------------
// History panel
// ---------------------------------------------------------------------------
export function createHistoryPanel(): HTMLDivElement {
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

export function toggleHistoryPanel() {
  if (st.historyPanel.style.display === 'block') {
    hideHistoryPanel();
  } else {
    showHistoryPanel();
  }
}

function showHistoryPanel() {
  actions().hideSettingsPanel();
  st.historyPanel.style.display = 'block';
  positionHistoryPanel();
  loadHistoryData();
}

export function hideHistoryPanel() {
  st.historyPanel.style.display = 'none';
}

function positionHistoryPanel() {
  const historyBtn = st.toolbarEl.querySelector<HTMLButtonElement>('[data-action="history"]')!;
  const btnRect = historyBtn.getBoundingClientRect();
  const panelWidth = 360;
  const gap = 12;

  let left = btnRect.left + btnRect.width / 2 - panelWidth / 2;
  const top = btnRect.top - gap;

  if (left + panelWidth > window.innerWidth - 8) left = window.innerWidth - panelWidth - 8;
  if (left < 8) left = 8;

  st.historyPanel.style.left = `${left}px`;
  st.historyPanel.style.top = 'auto';
  st.historyPanel.style.bottom = `${window.innerHeight - top}px`;
}

function loadHistoryData() {
  const body = st.historyPanel.querySelector<HTMLDivElement>('.history-body')!;

  chrome.storage.local.get<FunnyHistoryStorage>('funnyHistory', (result) => {
    const history = result.funnyHistory ?? [];

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
      const { threadId, serverUrl, projectId } = entry;
      if (threadId && serverUrl) {
        item.title = 'Open thread in Funny';
        item.addEventListener('click', () => {
          window.open(threadUrl(serverUrl, { id: threadId, projectId }), '_blank');
        });
      }

      body.appendChild(item);
    });
  });
}

export function saveToHistory(serializedAnnotations: any[], threadId?: string, projectId?: string) {
  const entry: HistoryEntry = {
    id: `hist_${Date.now()}`,
    timestamp: Date.now(),
    url: window.location.href,
    title: document.title,
    threadId: threadId || null,
    projectId: projectId || null,
    annotationCount: serializedAnnotations.length,
    annotations: serializedAnnotations,
  };

  safeSendMessage({ type: 'GET_CONFIG' }, (config: any) => {
    const serverUrl = config?.serverUrl || 'http://localhost:3001';
    entry.serverUrl = serverUrl;

    // Store in chrome.storage.local (keep last 50 entries)
    chrome.storage.local.get<FunnyHistoryStorage>('funnyHistory', (result) => {
      const history = result.funnyHistory ?? [];
      history.unshift(entry);
      if (history.length > 50) history.length = 50;
      chrome.storage.local.set({ funnyHistory: history });
    });
  });
}
