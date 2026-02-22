/**
 * Funny UI Annotator - Background Service Worker
 *
 * Handles:
 * - Authentication with Funny server (bearer token)
 * - Creating threads via POST /api/threads
 * - Fetching providers/models from GET /api/setup/status
 * - Capturing screenshots via chrome.tabs API
 */

// Default config — provider and model are intentionally empty so we can
// detect "never saved" and use the server's defaults instead.
const DEFAULT_CONFIG = {
  serverUrl: 'http://localhost:3001',
  projectId: '',
  provider: '',
  model: '',
  permissionMode: 'autoEdit',
  mode: 'worktree'
};

// ---------------------------------------------------------------------------
// Config management
// ---------------------------------------------------------------------------
async function getConfig() {
  const result = await chrome.storage.local.get('funnyConfig');
  return { ...DEFAULT_CONFIG, ...result.funnyConfig };
}

async function saveConfig(config) {
  await chrome.storage.local.set({ funnyConfig: { ...DEFAULT_CONFIG, ...config } });
}

// ---------------------------------------------------------------------------
// Auth token
// ---------------------------------------------------------------------------
async function getAuthToken(serverUrl) {
  // Check cached token first
  const cached = await chrome.storage.local.get('funnyToken');
  if (cached.funnyToken) return cached.funnyToken;

  const res = await fetch(`${serverUrl}/api/bootstrap`);
  if (!res.ok) throw new Error(`Bootstrap failed: ${res.status}`);

  const data = await res.json();
  const token = data.token;
  if (token) {
    await chrome.storage.local.set({ funnyToken: token });
  }
  return token;
}

// ---------------------------------------------------------------------------
// Fetch projects
// ---------------------------------------------------------------------------
async function fetchProjects(serverUrl, token) {
  const res = await fetch(`${serverUrl}/api/projects`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Projects fetch failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Fetch providers & models from Funny
// ---------------------------------------------------------------------------
async function fetchSetupStatus(serverUrl, token) {
  const res = await fetch(`${serverUrl}/api/setup/status`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Setup status failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Create thread in Funny
// ---------------------------------------------------------------------------
async function createThread(config, token, data) {
  const { serverUrl, projectId, provider, model, permissionMode, mode } = config;

  if (!projectId) {
    throw new Error('No project selected. Open settings in the toolbar and select a project.');
  }

  // Build the prompt from annotations
  const prompt = data.markdown;

  // Build images array (page screenshot)
  const images = [];
  if (data.screenshot) {
    // screenshot is a data URL: "data:image/png;base64,..."
    const base64Data = data.screenshot.replace(/^data:image\/\w+;base64,/, '');
    images.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: base64Data
      }
    });
  }

  // Build a descriptive title from the first annotation's prompt (primary action)
  const firstPrompt = data.annotations?.[0]?.prompt || '';
  const pageTitle = data.title || data.url;
  const threadTitle = firstPrompt
    ? `${firstPrompt.slice(0, 70)} — ${pageTitle}`.slice(0, 100)
    : `UI Review: ${pageTitle}`.slice(0, 100);

  const body = {
    projectId,
    title: threadTitle,
    mode,
    provider: provider || undefined,
    model: model || undefined,
    permissionMode,
    source: 'chrome_extension',
    prompt,
    images
  };

  const res = await fetch(`${serverUrl}/api/threads`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Thread creation failed (${res.status}): ${text}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SEND_TO_FUNNY') {
    handleSendToFunny(msg.data)
      .then(result => sendResponse({ success: true, threadId: result.id }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep channel open for async
  }

  if (msg.type === 'CAPTURE_SCREENSHOT') {
    chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
      sendResponse({ screenshot: dataUrl });
    });
    return true;
  }

  if (msg.type === 'GET_CONFIG') {
    getConfig().then(config => sendResponse(config));
    return true;
  }

  if (msg.type === 'SAVE_CONFIG') {
    saveConfig(msg.config).then(() => sendResponse({ success: true }));
    return true;
  }

  if (msg.type === 'FETCH_PROJECTS') {
    handleFetchProjects()
      .then(projects => sendResponse({ success: true, projects }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'FETCH_SETUP_STATUS') {
    handleFetchSetupStatus()
      .then(data => sendResponse({ success: true, ...data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'TEST_CONNECTION') {
    handleTestConnection(msg.serverUrl)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'INJECT_PAGE_BRIDGE') {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ success: false }); return true; }
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['page-bridge.js'],
      world: 'MAIN',
    })
      .then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (msg.type === 'CLEAR_TOKEN') {
    chrome.storage.local.remove('funnyToken').then(() => sendResponse({ success: true }));
    return true;
  }

  if (msg.type === 'GET_FULL_CONFIG') {
    handleGetFullConfig()
      .then(data => sendResponse(data))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function handleSendToFunny(data) {
  const config = await getConfig();
  const token = await getAuthToken(config.serverUrl);
  return createThread(config, token, data);
}

async function handleFetchProjects() {
  const config = await getConfig();
  const token = await getAuthToken(config.serverUrl);
  const result = await fetchProjects(config.serverUrl, token);
  return result.projects || result;
}

async function handleFetchSetupStatus() {
  const config = await getConfig();
  const token = await getAuthToken(config.serverUrl);
  const data = await fetchSetupStatus(config.serverUrl, token);
  return data;
}

async function handleTestConnection(serverUrl) {
  try {
    // Clear cached token when testing new URL
    await chrome.storage.local.remove('funnyToken');
    const token = await getAuthToken(serverUrl || DEFAULT_CONFIG.serverUrl);
    return { success: true, token: token ? 'obtained' : 'missing' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleGetFullConfig() {
  const config = await getConfig();
  const result = { success: true, config };

  try {
    const token = await getAuthToken(config.serverUrl);
    const [projectsData, setupData] = await Promise.all([
      fetchProjects(config.serverUrl, token).catch(() => ({ projects: [] })),
      fetchSetupStatus(config.serverUrl, token).catch(() => ({ providers: {} })),
    ]);
    result.projects = projectsData.projects || projectsData;
    result.providers = setupData.providers || {};
    result.connected = true;
  } catch (_) {
    result.projects = [];
    result.providers = {};
    result.connected = false;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Extension icon click = toggle annotator in active tab
// ---------------------------------------------------------------------------
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  // Check for restricted pages
  const url = tab.url || '';
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
      url.startsWith('about:') || url.startsWith('edge://') ||
      url.includes('chromewebstore.google.com')) {
    return; // Silently ignore restricted pages
  }

  // Try to toggle annotator in the active tab
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_ANNOTATOR' });
  } catch (_) {
    // Content script not loaded — inject it and then activate
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
      // Wait for content script to initialize
      await new Promise((r) => setTimeout(r, 200));
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_ANNOTATOR' });
    } catch (_) {
      // Cannot inject — page may be restricted
    }
  }
});
