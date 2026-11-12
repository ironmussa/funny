import { sleep as effectSleep } from '@funny/shared/async';

import {
  ApiError,
  IMAGE_MAX_BYTES,
  apiErrorFromResponse,
  buildApiRequest,
  buildCreateThreadBody,
  connectionFailure,
  hostPermissionFor,
  isOversizedImage,
  normalizeServerUrl,
  resolveConnection,
  toProviderMap,
  unreachableError,
  type AnnotationData,
  type ApiConnection,
  type PublicModelList,
} from './api';
/**
 * Funny UI Annotator - Background Service Worker
 *
 * Talks to funny's public REST API v1 (`/api/v1`) with a personal API token
 * (`Authorization: Bearer funny_pat_…`, created in funny under
 * Settings > API tokens):
 * - Creating threads via POST /api/v1/threads
 * - Fetching providers/models via GET /api/v1/models
 * - Fetching projects via GET /api/v1/projects (and /projects/resolve)
 * - Capturing screenshots via chrome.tabs API
 */

// ---------------------------------------------------------------------------
// Config types & defaults
// ---------------------------------------------------------------------------

interface ExtensionConfig {
  serverUrl: string;
  /** Personal API token (`funny_pat_…`). */
  apiToken: string;
  projectId: string;
  provider: string;
  model: string;
  /** Only `ask` / `confirmEdit` / `plan` are sent; anything else lets the server default to `ask`. */
  permissionMode: string;
  mode: string;
}

const DEFAULT_CONFIG: ExtensionConfig = {
  serverUrl: 'http://localhost:3001',
  apiToken: '',
  projectId: '',
  provider: '',
  model: '',
  permissionMode: 'ask',
  mode: 'worktree',
};

// ---------------------------------------------------------------------------
// Config management
// ---------------------------------------------------------------------------

async function getConfig(): Promise<ExtensionConfig> {
  const result = await chrome.storage.local.get('funnyConfig');
  return { ...DEFAULT_CONFIG, ...(result.funnyConfig as Partial<ExtensionConfig> | undefined) };
}

/** Merges into the stored config, so a partial save keeps the other fields (the token among them). */
async function saveConfig(config: Partial<ExtensionConfig>): Promise<void> {
  const current = await getConfig();
  const next = { ...current, ...config };
  next.serverUrl = normalizeServerUrl(next.serverUrl || DEFAULT_CONFIG.serverUrl);
  next.apiToken = (next.apiToken || '').trim();
  await chrome.storage.local.set({ funnyConfig: next });
}

// The token used to come from GET /api/bootstrap and was cached as `funnyToken`.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.remove('funnyToken');
});

// ---------------------------------------------------------------------------
// Authenticated fetch helper (public API v1)
// ---------------------------------------------------------------------------

/** Whether the extension may fetch the server's origin (localhost is in `host_permissions`). */
async function hasHostPermission(serverUrl: string): Promise<boolean> {
  const pattern = hostPermissionFor(serverUrl);
  if (!pattern) return true;
  return chrome.permissions.contains({ origins: [pattern] });
}

async function apiFetchWith(
  connection: ApiConnection,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<any> {
  const request = buildApiRequest(connection, path, init);
  if (!(await hasHostPermission(connection.serverUrl))) {
    throw new ApiError(
      `Allow the extension to reach ${normalizeServerUrl(connection.serverUrl)}: open the extension options and click "Save & test connection"`,
      'permission',
    );
  }

  let res: Response;
  try {
    res = await fetch(request.url, request.init);
  } catch {
    throw unreachableError(connection.serverUrl);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw apiErrorFromResponse(res.status, text);
  }
  return res.json();
}

async function apiFetch(path: string, init: { method?: string; body?: unknown } = {}) {
  const config = await getConfig();
  return apiFetchWith(config, path, init);
}

// ---------------------------------------------------------------------------
// Create thread via API
// ---------------------------------------------------------------------------

/**
 * A screenshot the API accepts: PNG captures over 5 MB (large hi-DPI screens)
 * are re-encoded as JPEG.
 */
async function fitScreenshot(dataUrl: string | undefined): Promise<string | undefined> {
  if (!dataUrl || !isOversizedImage(dataUrl)) return dataUrl;
  // On failure, send it as is: the server explains the size limit.
  return reencodeAsJpeg(dataUrl).catch(() => dataUrl);
}

async function reencodeAsJpeg(dataUrl: string): Promise<string> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  for (const quality of [0.85, 0.7, 0.5]) {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    if (blob.size <= IMAGE_MAX_BYTES) return blobToDataUrl(blob);
  }
  return dataUrl;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

async function createThreadFromAnnotations(config: ExtensionConfig, data: AnnotationData) {
  const body = buildCreateThreadBody(config, data, await fitScreenshot(data.screenshot));
  const result = await apiFetch('/threads', { method: 'POST', body });
  return result.thread as { id: string; projectId: string };
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

type MessageHandler = (msg: any, sender: chrome.runtime.MessageSender) => Promise<unknown>;

/** Answers `{ success: true, ...data }`, or `{ success: false, error }` when the call fails. */
function answer(call: () => Promise<object>): Promise<object> {
  return call().then(
    (data) => ({ success: true, ...data }),
    (err: Error) => ({ success: false, error: err.message }),
  );
}

const handlers: Record<string, MessageHandler> = {
  SEND_TO_FUNNY: (msg) =>
    answer(async () => {
      const thread = await handleSendToFunny(msg.data);
      return { threadId: thread.id, projectId: thread.projectId };
    }),
  CAPTURE_SCREENSHOT: () =>
    new Promise((resolve) => {
      chrome.tabs.captureVisibleTab(null as any, { format: 'png' }, (dataUrl) => {
        resolve({ screenshot: dataUrl });
      });
    }),
  GET_CONFIG: (_msg, sender) => getConfig().then((config) => configForSender(config, sender)),
  SAVE_CONFIG: (msg, sender) =>
    saveConfig(configFromSender(msg.config ?? {}, sender)).then(() => ({ success: true })),
  FETCH_PROJECTS: () => answer(async () => ({ projects: await handleFetchProjects() })),
  RESOLVE_PROJECT: (msg) => answer(() => handleResolveProject(msg.url)),
  FETCH_MODELS: () => answer(async () => ({ providers: await handleFetchModels() })),
  TEST_CONNECTION: (msg) => handleTestConnection(msg.serverUrl, msg.apiToken),
  OPEN_OPTIONS: () => chrome.runtime.openOptionsPage().then(() => ({ success: true })),
  INJECT_PAGE_BRIDGE: (_msg, sender) => injectPageBridge(sender.tab?.id),
  GET_FULL_CONFIG: (_msg, sender) =>
    handleGetFullConfig().then(
      (data) => ({ ...data, config: configForSender(data.config, sender) }),
      (err: Error) => ({ success: false, error: err.message }),
    ),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!Object.hasOwn(handlers, msg?.type)) return;
  handlers[msg.type](msg, sender).then(sendResponse);
  return true;
});

/** Whether a message comes from one of the extension's own pages (popup / options). */
function fromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return Boolean(sender.url?.startsWith(chrome.runtime.getURL('')));
}

/**
 * The config as a sender may see it. Content scripts render into the page's
 * DOM (an open shadow root), so they never get the token, only whether one is set.
 */
function configForSender(config: ExtensionConfig, sender: chrome.runtime.MessageSender) {
  if (fromExtensionPage(sender)) return config;
  const { apiToken, ...rest } = config;
  return { ...rest, hasApiToken: Boolean(apiToken) };
}

/** What a sender may save: the token only from the extension's own pages. */
function configFromSender(
  config: Partial<ExtensionConfig> & { hasApiToken?: boolean },
  sender: chrome.runtime.MessageSender,
): Partial<ExtensionConfig> {
  const { hasApiToken: _hasApiToken, ...rest } = config;
  if (fromExtensionPage(sender)) return rest;
  const { apiToken: _apiToken, ...withoutToken } = rest;
  return withoutToken;
}

async function injectPageBridge(tabId: number | undefined) {
  if (!tabId) return { success: false };
  return chrome.scripting
    .executeScript({ target: { tabId }, files: ['page-bridge.js'], world: 'MAIN' as any })
    .then(
      () => ({ success: true }),
      () => ({ success: false }),
    );
}

async function handleSendToFunny(data: AnnotationData) {
  const config = await getConfig();
  return createThreadFromAnnotations(config, data);
}

async function handleFetchProjects(): Promise<any[]> {
  const data = await apiFetch('/projects');
  return data.projects ?? [];
}

async function handleResolveProject(url: string): Promise<{ project: any; source: string }> {
  return apiFetch(`/projects/resolve?url=${encodeURIComponent(url)}`);
}

async function handleFetchModels() {
  return toProviderMap((await apiFetch('/models')) as PublicModelList);
}

/**
 * Checks the entered server URL and token with `GET /api/v1/projects`. The
 * in-page panel sends no token (it never holds it), so the saved one is tested.
 */
async function handleTestConnection(serverUrl?: string, apiToken?: string) {
  const connection = resolveConnection(await getConfig(), serverUrl, apiToken);
  return apiFetchWith(connection, '/projects').then(() => ({ success: true }), connectionFailure);
}

async function handleGetFullConfig() {
  const config = await getConfig();
  const state = await Promise.all([
    apiFetch('/projects'),
    apiFetch('/models').catch(() => null),
  ]).then(
    ([projectsData, modelsData]) => ({
      connected: true,
      projects: projectsData.projects ?? [],
      providers: toProviderMap(modelsData as PublicModelList | null),
    }),
    (err: unknown) => {
      const failure = connectionFailure(err);
      return {
        connected: false,
        projects: [],
        providers: {},
        connectionError: failure.error,
        connectionReason: failure.reason,
      };
    },
  );
  return { success: true, config, ...state };
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
      await effectSleep(200);
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_ANNOTATOR' });
    } catch {
      // Cannot inject — page may be restricted
    }
  }
});
