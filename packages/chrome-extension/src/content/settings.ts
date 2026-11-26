/** Settings panel: server, token, project, provider and model. */

import { DEFAULT_THREAD_MODE } from '@funny/shared/models';

import { hasProjectDefaults, isPermissionError } from '../api';
import { actions } from './actions';
import { createElement, safeSendMessage } from './dom';
import { st } from './state';

// ---------------------------------------------------------------------------
// Settings panel (inline, replaces popup)
// ---------------------------------------------------------------------------
export function createSettingsPanel(): HTMLDivElement {
  const panel = createElement('div', 'settings-panel');
  panel.style.display = 'none';
  panel.innerHTML = `
    <div class="settings-header">
      <div class="settings-title">
        <span class="settings-logo">F</span>
        <span>Settings</span>
        <span class="settings-dot" title="Not connected"></span>
      </div>
      <button class="settings-close-btn" title="Close">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
    <div class="settings-body">
      <div class="settings-field">
        <label>Server URL</label>
        <div class="settings-url-row">
          <input type="text" class="settings-input" data-key="serverUrl" placeholder="http://localhost:3001" />
          <button class="settings-connect-btn" title="Connect">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M5 12h14"></path>
              <path d="M12 5l7 7-7 7"></path>
            </svg>
          </button>
        </div>
        <div class="settings-status"></div>
        <button type="button" class="settings-link-btn settings-grant-btn" style="display: none">
          Open extension options to allow this server
        </button>
      </div>
      <div class="settings-field">
        <label>API token</label>
        <div class="settings-url-row">
          <span class="settings-token-state">Not set</span>
          <button type="button" class="settings-link-btn settings-token-btn">Set token</button>
        </div>
        <div class="settings-hint">
          Create one in funny: Settings &gt; API tokens. It is entered in the extension's
          options page, never on this page.
        </div>
      </div>
      <div class="settings-field">
        <label>Project</label>
        <select class="settings-select" data-key="projectId">
          <option value="">Loading...</option>
        </select>
      </div>
      <div class="settings-field">
        <label>Provider</label>
        <select class="settings-select" data-key="provider">
          <option value="">Loading...</option>
        </select>
      </div>
      <div class="settings-row">
        <div class="settings-field">
          <label>Model</label>
          <select class="settings-select" data-key="model">
            <option value="">-</option>
          </select>
        </div>
        <div class="settings-field">
          <label>Mode</label>
          <select class="settings-select" data-key="mode">
            <option value="local">Local</option>
            <option value="worktree">Worktree</option>
          </select>
        </div>
      </div>
      <div class="settings-react-status"></div>
    </div>
  `;

  // Close button
  panel.querySelector('.settings-close-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    hideSettingsPanel();
  });

  // Connect button
  panel.querySelector('.settings-connect-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    testSettingsConnection();
  });

  // The token and a remote server's host permission are set in the options
  // page: an extension page, out of reach of this page's scripts, and the only
  // place `chrome.permissions.request` can run.
  panel.querySelectorAll('.settings-token-btn, .settings-grant-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      saveSettings();
      safeSendMessage({ type: 'OPEN_OPTIONS' });
    });
  });

  // Auto-save on change
  panel
    .querySelectorAll<HTMLSelectElement | HTMLInputElement>('.settings-select, .settings-input')
    .forEach((target) => {
      target.addEventListener('change', (e) => {
        e.stopPropagation();
        // If provider changed, repopulate models
        if (target.dataset.key === 'provider') {
          populateSettingsModels(target.value);
        }
        // If project changed, apply project defaults to provider/model/mode
        if (target.dataset.key === 'projectId') {
          applyProjectDefaults(target.value);
        }
        saveSettings();
      });
    });

  // Prevent clicks inside panel from triggering annotation
  panel.addEventListener('click', (e) => e.stopPropagation());
  panel.addEventListener('mousedown', (e) => e.stopPropagation());

  return panel;
}

export function toggleSettingsPanel() {
  if (st.settingsPanel.style.display === 'block') {
    hideSettingsPanel();
  } else {
    showSettingsPanel();
  }
}

function showSettingsPanel() {
  actions().hideHistoryPanel();
  st.settingsPanel.style.display = 'block';
  positionSettingsPanel();
  loadSettingsData();
  updateFrameworkStatus();
}

function detectFramework(): string {
  // Ask page-bridge.js (MAIN world) to detect JS frameworks.
  // Returns a comma-separated string like "React, Next.js" or "" if none found.
  try {
    document.documentElement.removeAttribute('data-funny-framework');
    document.dispatchEvent(new Event('__funny_detect_framework'));
    const result = document.documentElement.getAttribute('data-funny-framework') || '';
    console.info('[Funny Annotator] Framework detect result:', result || 'none');
    document.documentElement.removeAttribute('data-funny-framework');
    return result;
  } catch {
    return '';
  }
}

function updateFrameworkStatus() {
  const el = st.settingsPanel.querySelector<HTMLDivElement>('.settings-react-status')!;
  const frameworks = detectFramework();
  if (frameworks) {
    el.style.display = 'none';
    el.innerHTML = '';
  } else {
    el.style.display = 'flex';
    el.className = 'settings-react-status settings-react-no';
    el.innerHTML =
      '<span class="settings-react-dot settings-react-dot-no"></span> No JS framework detected — component tree data will not be included in annotations';
  }
}

export function hideSettingsPanel() {
  st.settingsPanel.style.display = 'none';
}

function positionSettingsPanel() {
  const settingsBtn = st.toolbarEl.querySelector<HTMLButtonElement>('[data-action="settings"]')!;
  const btnRect = settingsBtn.getBoundingClientRect();
  const panelWidth = 340;
  const gap = 12;

  // Center panel horizontally on the settings button
  let left = btnRect.left + btnRect.width / 2 - panelWidth / 2;
  const top = btnRect.top - gap;

  // Keep within viewport
  if (left + panelWidth > window.innerWidth - 8) left = window.innerWidth - panelWidth - 8;
  if (left < 8) left = 8;

  // Show above by default; measure height after display
  st.settingsPanel.style.left = `${left}px`;
  st.settingsPanel.style.top = 'auto';
  st.settingsPanel.style.bottom = `${window.innerHeight - top}px`;
}

async function loadSettingsData() {
  const statusEl = st.settingsPanel.querySelector<HTMLDivElement>('.settings-status')!;
  statusEl.textContent = 'Loading...';
  statusEl.className = 'settings-status';

  try {
    const data = await new Promise<any>((resolve) => {
      safeSendMessage({ type: 'GET_FULL_CONFIG' }, resolve);
    });

    if (!data?.success) {
      statusEl.textContent = data?.error || 'Failed to load config';
      statusEl.className = 'settings-status settings-status-error';
      return;
    }

    const config = data.config || {};

    // Populate server URL
    const serverInput = st.settingsPanel.querySelector<HTMLInputElement>('[data-key="serverUrl"]')!;
    serverInput.value = config.serverUrl || 'http://localhost:3001';
    updateTokenState(Boolean(config.hasApiToken));

    // Populate projects
    st.settingsProjectsData = data.projects || [];
    const projectSelect =
      st.settingsPanel.querySelector<HTMLSelectElement>('[data-key="projectId"]')!;
    projectSelect.innerHTML = '<option value="">Select a project...</option>';
    st.settingsProjectsData.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === config.projectId) opt.selected = true;
      projectSelect.appendChild(opt);
    });

    // Look up project defaults for the selected project
    const selectedProject = config.projectId
      ? st.settingsProjectsData.find((p) => p.id === config.projectId)
      : null;

    // Populate mode — project default > fallback
    const modeSelect = st.settingsPanel.querySelector<HTMLSelectElement>('[data-key="mode"]')!;
    const effectiveMode = selectedProject?.defaultMode || config.mode || DEFAULT_THREAD_MODE;
    modeSelect.value = effectiveMode;

    // Populate providers
    st.settingsProviderData = data.providers || {};
    const providerSelect =
      st.settingsPanel.querySelector<HTMLSelectElement>('[data-key="provider"]')!;
    providerSelect.innerHTML = '';
    const available = Object.entries(st.settingsProviderData!).filter(([, info]) => info.available);

    if (available.length === 0) {
      providerSelect.innerHTML = '<option value="">No providers</option>';
    } else {
      // Resolve provider: project default > saved config > first available
      const projectDefaultProvider = selectedProject?.defaultProvider;
      const effectiveProvider =
        projectDefaultProvider && st.settingsProviderData![projectDefaultProvider]?.available
          ? projectDefaultProvider
          : config.provider && st.settingsProviderData![config.provider]?.available
            ? config.provider
            : available[0][0];
      available.forEach(([key, info]) => {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = info.label || key;
        if (key === effectiveProvider) opt.selected = true;
        providerSelect.appendChild(opt);
      });
      providerSelect.value = effectiveProvider;
      // Resolve model: project default > saved config > provider default
      const effectiveModel = selectedProject?.defaultModel || config.model || undefined;
      populateSettingsModels(effectiveProvider, effectiveModel);
    }

    // Connection state (dot + connect button + status text)
    const dot = st.settingsPanel.querySelector<HTMLSpanElement>('.settings-dot')!;
    const connectBtn = st.settingsPanel.querySelector<HTMLButtonElement>('.settings-connect-btn')!;
    if (data.connected) {
      dot.className = 'settings-dot settings-dot-ok';
      dot.title = 'Connected';
      connectBtn.className = 'settings-connect-btn settings-connect-btn-ok';
      statusEl.textContent = 'Connected';
      statusEl.className = 'settings-status settings-status-ok';
    } else {
      dot.className = 'settings-dot settings-dot-err';
      dot.title = 'Not connected';
      connectBtn.className = 'settings-connect-btn settings-connect-btn-err';
      statusEl.textContent = data.connectionError;
      statusEl.className = 'settings-status settings-status-error';
    }
    showGrantButton(data.connectionReason === 'permission');
  } catch {
    statusEl.textContent = 'Error loading settings';
    statusEl.className = 'settings-status settings-status-error';
  }
}

function updateTokenState(hasToken: boolean) {
  const state = st.settingsPanel.querySelector<HTMLSpanElement>('.settings-token-state')!;
  const btn = st.settingsPanel.querySelector<HTMLButtonElement>('.settings-token-btn')!;
  state.textContent = hasToken ? 'Saved' : 'Not set';
  state.classList.toggle('settings-token-missing', !hasToken);
  btn.textContent = hasToken ? 'Change token' : 'Set token';
}

function showGrantButton(show: boolean) {
  const btn = st.settingsPanel.querySelector<HTMLButtonElement>('.settings-grant-btn')!;
  btn.style.display = show ? 'block' : 'none';
}

function applyProjectDefaults(projectId: string) {
  const project = st.settingsProjectsData.find((p) => p.id === projectId);
  // The public API's projects carry no defaults: keep the saved choices.
  if (!hasProjectDefaults(project) || !st.settingsProviderData) return;

  const available = Object.entries(st.settingsProviderData).filter(([, info]) => info.available);
  if (available.length === 0) return;

  // Resolve provider: project default > 'claude'
  const effectiveProvider = project.defaultProvider || 'claude';
  const providerSelect =
    st.settingsPanel.querySelector<HTMLSelectElement>('[data-key="provider"]')!;
  if (st.settingsProviderData[effectiveProvider]?.available) {
    providerSelect.value = effectiveProvider;
  }

  // Resolve model: project default > provider's default
  const effectiveModel = project.defaultModel || '';
  populateSettingsModels(providerSelect.value, effectiveModel);

  // Resolve mode: project default > 'local'
  const modeSelect = st.settingsPanel.querySelector<HTMLSelectElement>('[data-key="mode"]')!;
  modeSelect.value = project.defaultMode || DEFAULT_THREAD_MODE;
}

function populateSettingsModels(provider: string, selectedModel?: string) {
  const modelSelect = st.settingsPanel.querySelector<HTMLSelectElement>('[data-key="model"]')!;
  modelSelect.innerHTML = '';

  if (!st.settingsProviderData || !st.settingsProviderData[provider]) {
    modelSelect.innerHTML = '<option value="">-</option>';
    return;
  }

  const info = st.settingsProviderData[provider];
  const models: Array<{ value: string; label: string }> =
    info.modelsWithLabels || info.models?.map((m: string) => ({ value: m, label: m })) || [];
  const effectiveModel =
    selectedModel && models.some((m) => m.value === selectedModel)
      ? selectedModel
      : info.defaultModel || models[0]?.value || '';

  models.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    if (m.value === effectiveModel) opt.selected = true;
    modelSelect.appendChild(opt);
  });

  modelSelect.value = effectiveModel;
}

function saveSettings() {
  const config: Record<string, string> = {};
  // Every [data-key] element in the settings panel is a <select> or an <input>.
  st.settingsPanel
    .querySelectorAll<HTMLSelectElement | HTMLInputElement>('[data-key]')
    .forEach((input) => {
      config[input.dataset.key!] = input.value;
    });
  safeSendMessage({ type: 'SAVE_CONFIG', config });

  // Update the project name in the toolbar
  const projectId = config.projectId;
  const project = projectId ? st.settingsProjectsData.find((p) => p.id === projectId) : null;
  actions().updateToolbarProjectName(project?.name || '');
}

async function testSettingsConnection() {
  const statusEl = st.settingsPanel.querySelector<HTMLDivElement>('.settings-status')!;
  const connectBtn = st.settingsPanel.querySelector<HTMLButtonElement>('.settings-connect-btn')!;
  const serverUrl = st.settingsPanel
    .querySelector<HTMLInputElement>('[data-key="serverUrl"]')!
    .value.trim();
  statusEl.textContent = 'Connecting...';
  statusEl.className = 'settings-status';
  connectBtn.className = 'settings-connect-btn';

  try {
    const result = await new Promise<any>((resolve) => {
      safeSendMessage({ type: 'TEST_CONNECTION', serverUrl }, resolve);
    });

    const dot = st.settingsPanel.querySelector<HTMLSpanElement>('.settings-dot')!;
    if (result?.success) {
      dot.className = 'settings-dot settings-dot-ok';
      connectBtn.className = 'settings-connect-btn settings-connect-btn-ok';
      statusEl.textContent = 'Connected';
      statusEl.className = 'settings-status settings-status-ok';
      showGrantButton(false);
      // Reload all data with new URL
      saveSettings();
      loadSettingsData();
    } else {
      dot.className = 'settings-dot settings-dot-err';
      connectBtn.className = 'settings-connect-btn settings-connect-btn-err';
      statusEl.textContent = result?.error || 'Connection failed';
      statusEl.className = 'settings-status settings-status-error';
      // Keep the entered URL so the options page opens with it.
      saveSettings();
      showGrantButton(isPermissionError(result));
    }
  } catch {
    connectBtn.className = 'settings-connect-btn settings-connect-btn-err';
    statusEl.textContent = 'Connection failed';
    statusEl.className = 'settings-status settings-status-error';
  }
}
