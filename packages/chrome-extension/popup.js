/**
 * Funny UI Annotator - Popup Script
 *
 * Providers and models are fetched dynamically from the Funny server
 * via GET /api/setup/status — nothing is hardcoded.
 */

const $ = (sel) => document.querySelector(sel);

// Elements
const connectionDot = $('#connectionDot');
const activateBtn = $('#activateBtn');
const annotationList = $('#annotationList');
const serverUrlInput = $('#serverUrl');
const projectSelect = $('#projectSelect');
const providerSelect = $('#providerSelect');
const modelSelect = $('#modelSelect');
const modeSelect = $('#modeSelect');
const testConnectionBtn = $('#testConnectionBtn');
const statusBar = $('#statusBar');
const statusText = $('#statusText');

let isAnnotatorActive = false;

// Cached provider data from the server
let providerData = null;

// Cached projects list (with defaults) from the server
let projectsData = [];

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  // Load config
  const config = await sendMessage({ type: 'GET_CONFIG' });
  serverUrlInput.value = config.serverUrl || 'http://localhost:3001';

  // Get state from content script
  try {
    const state = await sendToActiveTab({ type: 'GET_STATE' });
    isAnnotatorActive = state?.active || false;
    updateActivateButton();
    if (state?.annotations?.length) {
      renderAnnotationList(state.annotations);
    }
  } catch (_) {
    // Content script not loaded yet
  }

  // Fetch providers/models from server + projects in parallel
  await Promise.all([
    loadProviderOptions(),
    loadProjects(config.projectId),
  ]);

  // Apply project defaults after both providers and projects are loaded.
  // Project defaults take priority over saved config.
  if (config.projectId && providerData) {
    applyProjectDefaults(config.projectId);
  } else {
    // No project selected — use saved config or fallbacks
    applyFromConfig(config);
  }
  saveCurrentConfig();

  // Auto-test connection
  await testConnection(false);
});

// ---------------------------------------------------------------------------
// Provider / Model loading from Funny API
// ---------------------------------------------------------------------------

/**
 * Fetch available providers from the server and populate the provider dropdown.
 * Does NOT select a value — that's done by applyProjectDefaults or applyFromConfig.
 */
async function loadProviderOptions() {
  try {
    const result = await sendMessage({ type: 'FETCH_SETUP_STATUS' });
    if (!result.success) throw new Error(result.error);

    providerData = result.providers || {};

    // Populate provider select — only show available providers
    providerSelect.innerHTML = '';
    const availableProviders = Object.entries(providerData)
      .filter(([_, info]) => info.available);

    if (availableProviders.length === 0) {
      providerSelect.innerHTML = '<option value="">No providers available</option>';
      modelSelect.innerHTML = '<option value="">-</option>';
      return;
    }

    availableProviders.forEach(([key, info]) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = info.label || key;
      providerSelect.appendChild(opt);
    });
  } catch (err) {
    // Fallback: show empty selects
    providerSelect.innerHTML = '<option value="">Failed to load</option>';
    modelSelect.innerHTML = '<option value="">-</option>';
  }
}

/**
 * Apply saved config values when no project is selected.
 */
function applyFromConfig(config) {
  if (!providerData) return;

  const effectiveProvider = (config.provider && providerData[config.provider]?.available)
    ? config.provider
    : providerSelect.options[0]?.value || '';

  if (effectiveProvider) {
    providerSelect.value = effectiveProvider;
  }

  const effectiveModel = config.model || providerData[effectiveProvider]?.defaultModel || '';
  populateModels(providerSelect.value, effectiveModel);

  modeSelect.value = config.mode || 'worktree';
}

function populateModels(provider, selectedModel) {
  modelSelect.innerHTML = '';

  if (!providerData || !providerData[provider]) {
    modelSelect.innerHTML = '<option value="">-</option>';
    return;
  }

  const info = providerData[provider];
  // Use modelsWithLabels from the server (value + label pairs)
  const models = info.modelsWithLabels || info.models?.map(m => ({ value: m, label: m })) || [];

  // Use the provider's default model from the server when no model is specified
  // or when the selected model isn't valid for this provider
  const effectiveModel = (selectedModel && models.some(m => m.value === selectedModel))
    ? selectedModel
    : info.defaultModel || models[0]?.value || '';

  models.forEach(m => {
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
  } catch (err) {
    const reason = err?.message || '';
    if (reason === 'restricted-page') {
      setStatus('Browser internal pages (chrome://, extensions, etc.) cannot be annotated', 'error');
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

// Save config on change
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

function renderAnnotationList(annotations) {
  if (!annotations || annotations.length === 0) {
    annotationList.innerHTML = '<div class="empty-state">No annotations yet. Click "Start Annotating" and select elements on the page.</div>';
    return;
  }

  annotationList.innerHTML = annotations.map((ann, i) => {
    const names = (ann.elements || []).map(e => e.elementName).join(', ') || 'Unknown';
    return `
    <div class="annotation-item">
      <div class="annotation-number">${i + 1}</div>
      <div class="annotation-info">
        <div class="annotation-name">${escapeHtml(names)}</div>
        ${ann.prompt ? `<div class="annotation-comment">${escapeHtml(ann.prompt)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

async function loadProjects(selectedProjectId) {
  try {
    const result = await sendMessage({ type: 'FETCH_PROJECTS' });
    if (!result.success) throw new Error(result.error);

    projectsData = result.projects || [];
    projectSelect.innerHTML = '<option value="">Select a project...</option>';
    projectsData.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === selectedProjectId) opt.selected = true;
      projectSelect.appendChild(opt);
    });
  } catch (err) {
    projectSelect.innerHTML = '<option value="">Failed to load projects</option>';
  }
}

/**
 * Apply project-level defaults (provider, model, mode) to the popup selects.
 * Uses hardcoded fallbacks when the project has no defaults set.
 */
function applyProjectDefaults(projectId) {
  if (!projectId || !providerData) return;

  const project = projectsData.find(p => p.id === projectId);
  if (!project) return;

  // Resolve provider: project default > first available > 'claude'
  const effectiveProvider = project.defaultProvider || 'claude';
  if (providerData[effectiveProvider]?.available) {
    providerSelect.value = effectiveProvider;
  }

  // Resolve model: project default > provider's default
  const effectiveModel = project.defaultModel || '';
  populateModels(providerSelect.value, effectiveModel);

  // Resolve mode: project default > 'worktree'
  modeSelect.value = project.defaultMode || 'worktree';
}

async function testConnection(showFeedback) {
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
    // Reload providers and projects with new URL
    await saveCurrentConfig();
    const config = await sendMessage({ type: 'GET_CONFIG' });
    await Promise.all([
      loadProviderOptions(),
      loadProjects(config.projectId),
    ]);
    // Re-apply project defaults or config after reload
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
      mode: modeSelect.value
    }
  });
}

function setStatus(message, type) {
  statusText.textContent = message;
  statusBar.className = `status-bar ${type || ''}`;
}

// ---------------------------------------------------------------------------
// Messaging helpers
// ---------------------------------------------------------------------------
function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      resolve(response || {});
    });
  });
}

function sendToActiveTab(msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) return reject(new Error('no-tab'));

      // Check for restricted pages where content scripts cannot run
      const url = tab.url || '';
      if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
          url.startsWith('about:') || url.startsWith('edge://') ||
          url.includes('chromewebstore.google.com')) {
        return reject(new Error('restricted-page'));
      }

      // Try sending the message directly first
      try {
        const response = await new Promise((res, rej) => {
          chrome.tabs.sendMessage(tab.id, msg, (resp) => {
            if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
            else res(resp);
          });
        });
        return resolve(response);
      } catch (_) {
        // Content script not loaded — try injecting it
      }

      // Attempt programmatic injection
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
        });
      } catch (injectionError) {
        return reject(new Error('injection-failed'));
      }

      // Wait briefly for the content script to initialize, then retry
      await new Promise((r) => setTimeout(r, 200));

      chrome.tabs.sendMessage(tab.id, msg, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error('retry-failed'));
        } else {
          resolve(response);
        }
      });
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
