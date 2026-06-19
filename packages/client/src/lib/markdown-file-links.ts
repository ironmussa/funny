const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;
const POSIX_LOCAL_ROOT_RE =
  /^\/(?:home|Users|tmp|var|etc|opt|root|mnt|Volumes|workspace|workspaces)(?:\/|$)/;
const SCHEME_RE = /^[A-Za-z][A-Za-z\d+.-]*:/;
const TEXT_TOKEN_RE = /[^\s`"'<>()[\]{}]+/g;

function stripLineSuffix(path: string): string {
  return path.replace(/:\d+$/, '');
}

function hasFileExtension(path: string): boolean {
  const withoutLine = stripLineSuffix(path.split(/[?#]/, 1)[0] ?? path);
  const normalized = withoutLine.replace(/\\/g, '/');
  const filename = normalized.split('/').pop() ?? '';
  return /^\.[A-Za-z0-9_-]+$/.test(filename) || /.+\.[A-Za-z0-9][A-Za-z0-9_-]*$/.test(filename);
}

function decodePath(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function normalizeCandidate(raw: string | null | undefined): string | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;

  const unwrapped =
    trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1).trim() : trimmed;

  if (unwrapped.startsWith('file://')) {
    try {
      const url = new URL(unwrapped);
      const pathname = decodeURIComponent(url.pathname);
      return /^[A-Za-z]:/.test(pathname.slice(1)) ? pathname.slice(1) : pathname;
    } catch {
      return decodePath(unwrapped.replace(/^file:\/\//, ''));
    }
  }

  return decodePath(unwrapped);
}

export function isLikelyMarkdownFilePath(value: string | null | undefined): boolean {
  const path = normalizeCandidate(value);
  if (!path) return false;
  if (path.startsWith('#') || path.startsWith('//')) return false;
  if (SCHEME_RE.test(path) && !WINDOWS_ABSOLUTE_PATH_RE.test(path)) return false;
  if (WINDOWS_ABSOLUTE_PATH_RE.test(path)) return true;

  if (path.startsWith('/')) {
    return POSIX_LOCAL_ROOT_RE.test(path) || hasFileExtension(path);
  }

  return hasFileExtension(path);
}

function findLocalPathInText(text: string): string | null {
  const matches = text.match(TEXT_TOKEN_RE) ?? [];
  for (const match of matches) {
    const candidate = normalizeCandidate(match.replace(/[.,;:!?]+$/, ''));
    if (candidate && isLikelyMarkdownFilePath(candidate)) return candidate;
  }
  return null;
}

export function getMarkdownFileLinkPath(
  href: string | null | undefined,
  text: string | null | undefined,
): string | null {
  const hrefPath = normalizeCandidate(href);
  if (hrefPath && isLikelyMarkdownFilePath(hrefPath)) return hrefPath;
  if (hrefPath) return null;

  const textPath = normalizeCandidate(text);
  if (textPath && isLikelyMarkdownFilePath(textPath)) return textPath;

  return findLocalPathInText(String(text ?? ''));
}

export function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith('/') || WINDOWS_ABSOLUTE_PATH_RE.test(path);
}

function resolvePathSegments(path: string): string {
  const parts = path.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return '/' + resolved.join('/');
}

export function resolveMarkdownFilePath(filePath: string, basePath?: string | null): string {
  if (!basePath || isAbsoluteFilePath(filePath)) return filePath;

  const lineMatch = filePath.match(/^(.*?)(:\d+)$/);
  const pathPart = lineMatch ? lineMatch[1] : filePath;
  const linePart = lineMatch ? lineMatch[2] : '';

  const normalizedBase = basePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedPath = pathPart.replace(/\\/g, '/').replace(/^\.?\//, '');

  if (WINDOWS_ABSOLUTE_PATH_RE.test(normalizedBase)) {
    return `${normalizedBase}/${normalizedPath}${linePart}`;
  }

  return `${resolvePathSegments(`${normalizedBase}/${normalizedPath}`)}${linePart}`;
}
