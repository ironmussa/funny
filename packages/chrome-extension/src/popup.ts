/**
 * Funny UI Annotator - Popup Script
 *
 * Providers and models are fetched dynamically from the Funny server
 * via GET /api/setup/status — nothing is hardcoded.
 */

import type { ProviderInfo } from '@funny/funny-client';

const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;

// Elements
const connectionDot = $('#connectionDot')!;
const activateBtn = $('#activateBtn')!;
const annotationList = $('#annotationList')!;
const serverUrlInput = $('#serverUrl') as HTMLInputElement;
const projectSelect = $('#projectSelect') as HTMLSelectElement;
const providerSelect = $('#providerSelect') as HTMLSelectElement;
const modelSelect = $('#modelSelect') as HTMLSelectElement;
const modeSelect = $('#modeSelect') as HTMLSelectElement;
const testConnectionBtn = $('#testConnectionBtn')!;
const statusBar = $('#statusBar')!;
const statusText = $('#statusText')!;

let isAnnotatorActive = false;

// Cached provider data from the server
let providerData: Record<string, ProviderInfo> | null = null;

// Cached projects list (with defaults) from the server
let projectsData: Array<{
  id: string;
  name: string;
  defaultProvider?: string;
  defaultModel?: string;
  defaultMode?: string;
}> = [];

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  const config = await sendMessage({ type: 'GET_CONFIG' });
  serverUrlInput.value = config.serverUrl || 'http://localhost:3001';

  try {
    const state = await sendToActiveTab({ type: 'GET_STATE' });
    isAnnotatorActive = state?.active || false;
    updateActivateButton();
    if (state?.annotations?.length) {
      renderAnnotationList(state.annotations);
    }
  } catch {
    // Content script not loaded yet
  }

  await Promise.all([loadProviderOptions(), loadProjects(config.projectId)]);

  if (config.projectId && providerData) {
    applyProjectDefaults(config.projectId);
  } else {
    applyFromConfig(config);
  }
  saveCurrentConfig();

  await testConnection(false);
});

// ---------------------------------------------------------------------------
// Provider / Model loading
// ---------------------------------------------------------------------------

async function loadProviderOptions() {
  try {
    const result = await sendMessage({ type: 'FETCH_SETUP_STATUS' });
    if (!result.success) throw new Error(result.error);

    providerData = result.providers || {};

    providerSelect.innerHTML = '';
    const availableProviders = Object.entries(providerData!).filter(
      ([_, info]) => (info as ProviderInfo).available,
    );

    if (availableProviders.length === 0) {
      providerSelect.innerHTML = '<option value="">No providers available</option>';
      modelSelect.innerHTML = '<option value="">-</option>';
      return;
    }

    availableProviders.forEach(([key, info]) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = (info as ProviderInfo).label || key;
      providerSelect.appendChild(opt);
    });
  } catch {
    providerSelect.innerHTML = '<option value="">Failed to load</option>';
    modelSelect.innerHTML = '<option value="">-</option>';
  }
}

function applyFromConfig(config: any) {
  if (!providerData) return;

  const effectiveProvider =
    config.provider && providerData[config.provider]?.available
      ? config.provider
      : providerSelect.options[0]?.value || '';

  if (effectiveProvider) {
    providerSelect.value = effectiveProvider;
  }

  const effectiveModel = config.model || providerData[effectiveProvider]?.defaultModel || '';
  populateModels(providerSelect.value, effectiveModel);

  modeSelect.value = config.mode || 'worktree';
}

function populateModels(provider: string, selectedModel?: string) {
  modelSelect.innerHTML = '';

  if (!providerData || !providerData[provider]) {
    modelSelect.innerHTML = '<option value="">-</option>';
    return;
  }

  const info = providerData[provider];
  const models =
    info.modelsWithLabels || info.models?.map((m: string) => ({ value: m, label: m })) || [];

  const effectiveModel =
    selectedModel && models.some((m: any) => m.value === selectedModel)
      ? selectedModel
      : info.defaultModel || models[0]?.value || '';

  models.forEach((m: any) => {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    if (m.value === effectiveModel) opt.selected = true;
    modelSelect.appendChild(opt);
  });

  modelSelect.value = effectiveModel;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------
activateBtn.addEventListener('click', async () => {
  try {
    const response = await sendToActiveTab({ type: 'TOGGLE_ANNOTATOR' });
    isAnnotatorActive = response?.active || false;
    updateActivateButton();
  } catch (err: any) {
    const reason = err?.message || '';
    if (reason === 'restricted-page') {
      setStatus(
        'Browser internal pages (chrome://, extensions, etc.) cannot be annotated',
        'error',
      );
    } else if (reason === 'no-tab') {
      setStatus('No active tab found — click on a webpage and try again', 'error');
    } else if (reason === 'injection-failed') {
      setStatus('Could not inject annotator — reload the page and try again', 'error');
    } else {
      setStatus('Could not connect to the page — try reloading it', 'error');
    }
  }
});

testConnectionBtn.addEventListener('click', () => testConnection(true));

serverUrlInput.addEventListener('change', () => saveCurrentConfig());
projectSelect.addEventListener('change', () => {
  applyProjectDefaults(projectSelect.value);
  saveCurrentConfig();
});
providerSelect.addEventListener('change', () => {
  populateModels(providerSelect.value);
  saveCurrentConfig();
});
modelSelect.addEventListener('change', () => saveCurrentConfig());
modeSelect.addEventListener('change', () => saveCurrentConfig());

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------
function updateActivateButton() {
  if (isAnnotatorActive) {
    activateBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2"></rect>
        <line x1="9" y1="9" x2="15" y2="15"></line>
        <line x1="15" y1="9" x2="9" y2="15"></line>
      </svg>
      Stop Annotating
    `;
    activateBtn.classList.remove('btn-primary');
    activateBtn.classList.add('btn-secondary');
  } else {
    activateBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="16"></line>
        <line x1="8" y1="12" x2="16" y2="12"></line>
      </svg>
      Start Annotating
    `;
    activateBtn.classList.remove('btn-secondary');
    activateBtn.classList.add('btn-primary');
  }
}

function renderAnnotationList(annotations: any[]) {
  if (!annotations || annotations.length === 0) {
    annotationList.innerHTML =
      '<div class="empty-state">No annotations yet. Click "Start Annotating" and select elements on the page.</div>';
    return;
  }

  annotationList.innerHTML = annotations
    .map((ann: any, i: number) => {
      const names = (ann.elements || []).map((e: any) => e.elementName).join(', ') || 'Unknown';
      return `
    <div class="annotation-item">
      <div class="annotation-number">${i + 1}</div>
      <div class="annotation-info">
        <div class="annotation-name">${escapeHtml(names)}</div>
        ${ann.prompt ? `<div class="annotation-comment">${escapeHtml(ann.prompt)}</div>` : ''}
      </div>
    </div>`;
    })
    .join('');
}

async function loadProjects(selectedProjectId: string) {
  try {
    const result = await sendMessage({ type: 'FETCH_PROJECTS' });
    if (!result.success) throw new Error(result.error);

    projectsData = result.projects || [];
    projectSelect.innerHTML = '<option value="">Select a project...</option>';
    projectsData.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === selectedProjectId) opt.selected = true;
      projectSelect.appendChild(opt);
    });
  } catch {
    projectSelect.innerHTML = '<option value="">Failed to load projects</option>';
  }
}

function applyProjectDefaults(projectId: string) {
  if (!projectId || !providerData) return;

  const project = projectsData.find((p) => p.id === projectId);
  if (!project) return;

  const effectiveProvider = project.defaultProvider || 'claude';
  if (providerData[effectiveProvider]?.available) {
    providerSelect.value = effectiveProvider;
  }

  const effectiveModel = project.defaultModel || '';
  populateModels(providerSelect.value, effectiveModel);

  modeSelect.value = project.defaultMode || 'worktree';
}

async function testConnection(showFeedback: boolean) {
  const serverUrl = serverUrlInput.value.trim();
  if (!serverUrl) return;

  if (showFeedback) {
    setStatus('Connecting...', '');
  }

  const result = await sendMessage({ type: 'TEST_CONNECTION', serverUrl });

  if (result.success) {
    connectionDot.className = 'connection-dot connected';
    connectionDot.title = 'Connected';
    setStatus('Connected to Funny', 'success');
    await saveCurrentConfig();
    const config = await sendMessage({ type: 'GET_CONFIG' });
    await Promise.all([loadProviderOptions(), loadProjects(config.projectId)]);
    if (config.projectId && providerData) {
      applyProjectDefaults(config.projectId);
    } else {
      applyFromConfig(config);
    }
    saveCurrentConfig();
  } else {
    connectionDot.className = 'connection-dot error';
    connectionDot.title = 'Connection failed';
    setStatus(`Connection failed: ${result.error}`, 'error');
  }
}

async function saveCurrentConfig() {
  await sendMessage({
    type: 'SAVE_CONFIG',
    config: {
      serverUrl: serverUrlInput.value.trim(),
      projectId: projectSelect.value,
      provider: providerSelect.value,
      model: modelSelect.value,
      mode: modeSelect.value,
    },
  });
}

function setStatus(message: string, type: string) {
  statusText.textContent = message;
  statusBar.className = `status-bar ${type || ''}`;
}

// ---------------------------------------------------------------------------
// Messaging helpers
// ---------------------------------------------------------------------------
function sendMessage(msg: any): Promise<any> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      resolve(response || {});
    });
  });
}

function sendToActiveTab(msg: any): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) return reject(new Error('no-tab'));

      const url = tab.url || '';
      if (
        url.startsWith('chrome://') ||
        url.startsWith('chrome-extension://') ||
        url.startsWith('about:') ||
        url.startsWith('edge://') ||
        url.includes('chromewebstore.google.com')
      ) {
        return reject(new Error('restricted-page'));
      }

      try {
        const response = await new Promise((res, rej) => {
          chrome.tabs.sendMessage(tab.id!, msg, (resp) => {
            if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
            else res(resp);
          });
        });
        return resolve(response);
      } catch {
        // Content script not loaded — try injecting it
      }

      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id! },
          files: ['content.js'],
        });
      } catch {
        return reject(new Error('injection-failed'));
      }

      await new Promise((r) => setTimeout(r, 200));

      chrome.tabs.sendMessage(tab.id!, msg, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error('retry-failed'));
        } else {
          resolve(response);
        }
      });
    });
  });
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
