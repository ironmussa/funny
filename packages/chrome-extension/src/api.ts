/**
 * Pure helpers for the funny public REST API v1 (`/api/v1`), used by the
 * background worker. Nothing here touches `chrome.*` or the network, so it is
 * unit-tested with `bun test` (tests/api.test.ts).
 *
 * The API authenticates only with a personal API token
 * (`Authorization: Bearer funny_pat_…`), created in funny under
 * Settings > API tokens.
 */

export const MISSING_TOKEN_MESSAGE = 'Add an API token in settings: funny > Settings > API tokens';
export const INVALID_TOKEN_MESSAGE = 'The API token is invalid, expired or revoked';

/** The permission modes the public API accepts. Modes that act without asking are refused. */
const PUBLIC_PERMISSION_MODES = ['ask', 'confirmEdit', 'plan'] as const;
type PublicPermissionMode = (typeof PUBLIC_PERMISSION_MODES)[number];

/** Largest decoded image the public API accepts. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export interface ApiConnection {
  serverUrl: string;
  apiToken: string;
}

/** A failed API call, with the reason the UI branches on. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly reason: 'no-token' | 'bad-token' | 'unreachable' | 'permission' | 'http',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The server URL without trailing slashes (`http://host:3001/` → `http://host:3001`). */
export function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/, '');
}

/** The origin of a server URL, or null when it is not an http(s) URL. */
function serverOrigin(serverUrl: string): string | null {
  try {
    const url = new URL(normalizeServerUrl(serverUrl));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The host permission pattern to request for a server, or null when the
 * manifest's `host_permissions` already cover it (localhost:3001 / 127.0.0.1:3001).
 */
export function hostPermissionFor(serverUrl: string): string | null {
  const origin = serverOrigin(serverUrl);
  if (!origin) return null;
  if (origin === 'http://localhost:3001' || origin === 'http://127.0.0.1:3001') return null;
  return `${origin}/*`;
}

/** The URL and request init for a v1 call. Throws `ApiError('no-token')` without a token. */
export function buildApiRequest(
  connection: ApiConnection,
  path: string,
  init: { method?: string; body?: unknown } = {},
): { url: string; init: RequestInit } {
  const token = connection.apiToken.trim();
  if (!token) throw new ApiError(MISSING_TOKEN_MESSAGE, 'no-token');

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  const requestInit: RequestInit = { method: init.method ?? 'GET', headers };
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestInit.body = JSON.stringify(init.body);
  }
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return {
    url: `${normalizeServerUrl(connection.serverUrl)}/api/v1${suffix}`,
    init: requestInit,
  };
}

/**
 * The error for a non-2xx v1 response. The body is trpc-to-openapi's
 * `{ message, code, issues? }`; anything else falls back to the status.
 */
export function apiErrorFromResponse(status: number, bodyText: string): ApiError {
  if (status === 401) return new ApiError(INVALID_TOKEN_MESSAGE, 'bad-token', status);

  let message = '';
  try {
    const body = JSON.parse(bodyText) as {
      message?: unknown;
      issues?: Array<{ message?: unknown; path?: unknown }>;
    };
    if (typeof body?.message === 'string') message = body.message;
    const issue = Array.isArray(body?.issues) ? body.issues[0] : undefined;
    if (issue && typeof issue.message === 'string' && !message.includes(issue.message)) {
      const where =
        Array.isArray(issue.path) && issue.path.length ? `${issue.path.join('.')}: ` : '';
      message = message ? `${message} (${where}${issue.message})` : `${where}${issue.message}`;
    }
  } catch {
    // Not JSON: use the status below.
  }

  if (status === 404 && !message) {
    message = 'This funny server has no public API v1 — update the server';
  }
  return new ApiError(message || `Request failed (${status})`, 'http', status);
}

/** The error for a fetch that never got a response. */
export function unreachableError(serverUrl: string): ApiError {
  return new ApiError(
    `Cannot reach the funny server at ${normalizeServerUrl(serverUrl)}`,
    'unreachable',
  );
}

/** The stored permission mode if the public API accepts it, else undefined (the server uses `ask`). */
export function toPublicPermissionMode(mode: string | undefined): PublicPermissionMode | undefined {
  return (PUBLIC_PERMISSION_MODES as readonly string[]).includes(mode ?? '')
    ? (mode as PublicPermissionMode)
    : undefined;
}

/** Bytes a base64 string decodes to. */
function base64DecodedBytes(data: string): number {
  return (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
}

/** A `data:image/…;base64,…` URL as the public API's image, or null when it is not one. */
export function dataUrlToImage(
  dataUrl: string | undefined | null,
): { mediaType: ImageMediaType; data: string } | null {
  if (!dataUrl) return null;
  const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  const mediaType = (match[1] === 'image/jpg' ? 'image/jpeg' : match[1]) as ImageMediaType;
  if (!IMAGE_MEDIA_TYPES.includes(mediaType)) return null;
  return { mediaType, data: match[2] };
}

export interface ThreadConfig {
  projectId: string;
  provider: string;
  model: string;
  permissionMode: string;
  mode: string;
}

export interface AnnotationData {
  markdown: string;
  screenshot?: string;
  annotations?: Array<{ prompt?: string }>;
  title?: string;
  url?: string;
}

/** The thread title: the first annotation's prompt and the page, or "UI Review: <page>". */
function buildThreadTitle(data: AnnotationData): string {
  const firstPrompt = data.annotations?.[0]?.prompt || '';
  const pageTitle = data.title || data.url || '';
  return firstPrompt
    ? `${firstPrompt.slice(0, 70)} — ${pageTitle}`.slice(0, 100)
    : `UI Review: ${pageTitle}`.slice(0, 100);
}

/** The body of `POST /api/v1/threads`. `screenshot` is the (possibly re-encoded) data URL. */
export function buildCreateThreadBody(
  config: ThreadConfig,
  data: AnnotationData,
  screenshot: string | undefined = data.screenshot,
): Record<string, unknown> {
  if (!config.projectId) {
    throw new Error('No project selected. Open settings in the toolbar and select a project.');
  }
  const image = dataUrlToImage(screenshot);
  const body: Record<string, unknown> = {
    projectId: config.projectId,
    prompt: data.markdown,
    title: buildThreadTitle(data),
    client: 'chrome_extension',
  };
  if (config.mode === 'local' || config.mode === 'worktree') body.mode = config.mode;
  if (config.provider) body.provider = config.provider;
  if (config.model) body.model = config.model;
  const permissionMode = toPublicPermissionMode(config.permissionMode);
  if (permissionMode) body.permissionMode = permissionMode;
  if (image) body.images = [image];
  return body;
}

/** The web app's URL for a thread. */
export function threadUrl(
  serverUrl: string,
  thread: { id: string; projectId?: string | null },
): string {
  const base = normalizeServerUrl(serverUrl);
  if (thread.projectId) return `${base}/projects/${thread.projectId}/threads/${thread.id}`;
  return `${base}?thread=${thread.id}`;
}

/** Whether a screenshot data URL is an image the API would refuse for its size. */
export function isOversizedImage(dataUrl: string | undefined): boolean {
  const image = dataUrlToImage(dataUrl);
  return image !== null && base64DecodedBytes(image.data) > IMAGE_MAX_BYTES;
}

/** The connection to test: the entered values, falling back to the saved ones. */
export function resolveConnection(
  saved: ApiConnection,
  serverUrl?: string,
  apiToken?: string,
): ApiConnection {
  return { serverUrl: serverUrl || saved.serverUrl, apiToken: apiToken ?? saved.apiToken };
}

/** A failed call as the message the settings UI receives. */
export function connectionFailure(err: unknown): {
  success: false;
  reason: ApiError['reason'];
  error: string;
} {
  if (err instanceof ApiError) return { success: false, reason: err.reason, error: err.message };
  return { success: false, reason: 'unreachable', error: String((err as Error)?.message ?? err) };
}

/** Whether a settings response failed only for a missing host permission. */
export function isPermissionError(result: { reason?: string } | null | undefined): boolean {
  return result?.reason === 'permission';
}

/**
 * Whether a project carries its own provider / model / mode defaults. The
 * public API's projects carry none, so the saved choices are kept.
 */
export function hasProjectDefaults<
  P extends { defaultProvider?: string; defaultModel?: string; defaultMode?: string },
>(project: P | undefined): project is P {
  return Boolean(project?.defaultProvider || project?.defaultModel || project?.defaultMode);
}

// ── Providers and models ────────────────────────────────────────

/** `GET /api/v1/models`. */
export interface PublicModelList {
  defaultProvider: string;
  providers: Array<{
    id: string;
    name: string;
    defaultModel: string;
    models: Array<{ id: string; name: string }>;
  }>;
}

/** The provider shape the settings UI reads. */
export interface ProviderInfo {
  available: boolean;
  label?: string;
  defaultModel?: string;
  modelsWithLabels?: Array<{ value: string; label: string }>;
}

/**
 * The v1 model list as the provider map the settings UI reads, with the
 * server's default provider first (the UI falls back to the first one).
 */
export function toProviderMap(
  list: PublicModelList | null | undefined,
): Record<string, ProviderInfo> {
  const providers = [...(list?.providers ?? [])].sort(
    (a, b) => Number(b.id === list?.defaultProvider) - Number(a.id === list?.defaultProvider),
  );
  const map: Record<string, ProviderInfo> = {};
  for (const p of providers) {
    map[p.id] = {
      available: true,
      label: p.name,
      defaultModel: p.defaultModel,
      modelsWithLabels: p.models.map((m) => ({ value: m.id, label: m.name })),
    };
  }
  return map;
}
