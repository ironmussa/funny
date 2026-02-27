/**
 * Funny UI Annotator - Background Service Worker
 *
 * Handles:
 * - Authentication with Funny server (bearer token via /api/bootstrap)
 * - Creating threads via POST /api/threads
 * - Fetching providers/models via GET /api/setup/status
 * - Fetching projects via GET /api/projects
 * - Capturing screenshots via chrome.tabs API
 */

// ---------------------------------------------------------------------------
// Config types & defaults
// ---------------------------------------------------------------------------

interface ExtensionConfig {
  serverUrl: string;
  projectId: string;
  provider: string;
  model: string;
  permissionMode: string;
  mode: string;
}

const DEFAULT_CONFIG: ExtensionConfig = {
  serverUrl: 'http://localhost:3001',
  projectId: '',
  provider: '',
  model: '',
  permissionMode: 'autoEdit',
  mode: 'worktree',
};

// ---------------------------------------------------------------------------
// Config management
// ---------------------------------------------------------------------------

async function getConfig(): Promise<ExtensionConfig> {
  const result = await chrome.storage.local.get('funnyConfig');
  return { ...DEFAULT_CONFIG, ...result.funnyConfig };
}

async function saveConfig(config: Partial<ExtensionConfig>): Promise<void> {
  await chrome.storage.local.set({ funnyConfig: { ...DEFAULT_CONFIG, ...config } });
}

// ---------------------------------------------------------------------------
// Auth token
// ---------------------------------------------------------------------------

async function getAuthToken(serverUrl: string): Promise<string> {
  const cached = await chrome.storage.local.get('funnyToken');
  if (cached.funnyToken) return cached.funnyToken;

  const res = await fetch(`${serverUrl}/api/bootstrap`);
  if (!res.ok) throw new Error(`Bootstrap failed: ${res.status}`);
  const data = await res.json();
  const token = data.token ?? '';
  if (token) {
    await chrome.storage.local.set({ funnyToken: token });
  }
  return token;
}

// ---------------------------------------------------------------------------
// Authenticated fetch helper
// ---------------------------------------------------------------------------

async function apiFetch(path: string, options: RequestInit = {}): Promise<any> {
  const config = await getConfig();
  const token = await getAuthToken(config.serverUrl);
  const url = `${config.serverUrl}${path}`;

  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (options.body && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${options.method || 'GET'} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Annotation data shape from content script
// ---------------------------------------------------------------------------

interface AnnotationData {
  markdown: string;
  screenshot?: string;
  annotations?: Array<{ prompt?: string }>;
  title?: string;
  url?: string;
}

// ---------------------------------------------------------------------------
// Create thread via API
// ---------------------------------------------------------------------------

async function createThreadFromAnnotations(config: ExtensionConfig, data: AnnotationData) {
  if (!config.projectId) {
    throw new Error('No project selected. Open settings in the toolbar and select a project.');
  }

  const prompt = data.markdown;

  const images: Array<{
    type: string;
    source: { type: string; media_type: string; data: string };
  }> = [];
  if (data.screenshot) {
    const base64Data = data.screenshot.replace(/^data:image\/\w+;base64,/, '');
    images.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: base64Data },
    });
  }

  const firstPrompt = data.annotations?.[0]?.prompt || '';
  const pageTitle = data.title || data.url || '';
  const threadTitle = firstPrompt
    ? `${firstPrompt.slice(0, 70)} — ${pageTitle}`.slice(0, 100)
    : `UI Review: ${pageTitle}`.slice(0, 100);

  return apiFetch('/api/threads', {
    method: 'POST',
    body: JSON.stringify({
      projectId: config.projectId,
      prompt,
      title: threadTitle,
      mode: config.mode,
      provider: config.provider || undefined,
      model: config.model || undefined,
      permissionMode: config.permissionMode,
      source: 'chrome_extension',
      images: images.length > 0 ? images : undefined,
    }),
  });
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SEND_TO_FUNNY') {
    handleSendToFunny(msg.data)
      .then((result: any) => sendResponse({ success: true, threadId: result.id }))
      .catch((err: Error) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'CAPTURE_SCREENSHOT') {
    chrome.tabs.captureVisibleTab(null as any, { format: 'png' }, (dataUrl) => {
      sendResponse({ screenshot: dataUrl });
    });
    return true;
  }

  if (msg.type === 'GET_CONFIG') {
    getConfig().then((config) => sendResponse(config));
    return true;
  }

  if (msg.type === 'SAVE_CONFIG') {
    saveConfig(msg.config).then(() => sendResponse({ success: true }));
    return true;
  }

  if (msg.type === 'FETCH_PROJECTS') {
    handleFetchProjects()
      .then((projects) => sendResponse({ success: true, projects }))
      .catch((err: Error) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'FETCH_SETUP_STATUS') {
    handleFetchSetupStatus()
      .then((data) => sendResponse({ success: true, ...data }))
      .catch((err: Error) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'TEST_CONNECTION') {
    handleTestConnection(msg.serverUrl)
      .then((result) => sendResponse(result))
      .catch((err: Error) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'INJECT_PAGE_BRIDGE') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ success: false });
      return true;
    }
    chrome.scripting
      .executeScript({
        target: { tabId },
        files: ['page-bridge.js'],
        world: 'MAIN' as any,
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
      .then((data) => sendResponse(data))
      .catch((err: Error) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function handleSendToFunny(data: AnnotationData) {
  const config = await getConfig();
  return createThreadFromAnnotations(config, data);
}

async function handleFetchProjects(): Promise<any[]> {
  const data = await apiFetch('/api/projects');
  return data.projects || data;
}

async function handleFetchSetupStatus(): Promise<any> {
  return apiFetch('/api/setup/status');
}

async function handleTestConnection(serverUrl?: string) {
  try {
    await chrome.storage.local.remove('funnyToken');
    const url = serverUrl || DEFAULT_CONFIG.serverUrl;
    const token = await getAuthToken(url);
    return { success: true, token: token ? 'obtained' : 'missing' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function handleGetFullConfig() {
  const config = await getConfig();
  const result: any = { success: true, config };

  try {
    const [projectsData, setupData] = await Promise.all([
      apiFetch('/api/projects').catch(() => ({ projects: [] })),
      apiFetch('/api/setup/status').catch(() => ({ providers: {} })),
    ]);
    result.projects = projectsData.projects || projectsData;
    result.providers = setupData.providers || {};
    result.connected = true;
  } catch {
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

  const url = tab.url || '';
  if (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('about:') ||
    url.startsWith('edge://') ||
    url.includes('chromewebstore.google.com')
  ) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_ANNOTATOR' });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
      await new Promise((r) => setTimeout(r, 200));
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_ANNOTATOR' });
    } catch {
      // Cannot inject — page may be restricted
    }
  }
});
