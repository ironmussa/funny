import { ImageOff } from 'lucide-react';
import { useEffect, useState } from 'react';

import { createClientLogger } from '@/lib/client-logger';
import { cn } from '@/lib/utils';

const log = createClientLogger('media-error');

/**
 * Probe a media URL that just failed to load in an <img>/<video> and turn the
 * HTTP status into a human reason. The runner answers `/api/files/raw` with a
 * JSON `{ error }` body on deny/404 (see `routes/files.ts`), so we surface that
 * verbatim when present and fall back to a status-specific default otherwise.
 */
async function probeReason(url: string): Promise<string> {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (res.ok) return 'The file loaded but could not be displayed.';
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string };
      detail = body?.error ?? '';
    } catch {
      /* non-JSON error body — keep the status default */
    }
    switch (res.status) {
      case 401:
        return detail || 'Not authorized to access this file.';
      case 403:
        return detail || 'Access denied: path is outside the allowed directories.';
      case 404:
        return detail || 'File not found.';
      default:
        return detail || `Failed to load (HTTP ${res.status}).`;
    }
  } catch (e) {
    log.debug('media probe failed', { url, error: String(e) });
    return 'Could not reach the runner to load this file.';
  }
}

export interface MediaLoadErrorProps {
  /**
   * URL to probe for the real HTTP status (e.g. the resolved `/api/files/raw`
   * URL). When set, the widget refines its message from the runner's response;
   * when absent it shows `reason` (or a generic fallback) without a network hit.
   */
  probeUrl?: string;
  /** Static reason, used as the initial message and when `probeUrl` is absent. */
  reason?: string;
  /** Original path/source shown to the user for context. */
  path?: string;
  /** Fill the available height (file-preview pane) vs inline (chat). */
  fill?: boolean;
  className?: string;
}

/**
 * Shared "media couldn't load" widget. Replaces the browser's default broken-
 * image glyph across every media surface — chat markdown images, the binary
 * image/video visualizers, and the `MediaPreview` lightbox — with a consistent
 * card that names the actual reason (not authorized, not found, …).
 */
export function MediaLoadError({ probeUrl, reason, path, fill, className }: MediaLoadErrorProps) {
  const [message, setMessage] = useState(reason ?? 'Failed to load media.');

  useEffect(() => {
    if (!probeUrl) return;
    let cancelled = false;
    void probeReason(probeUrl).then((r) => {
      if (!cancelled) setMessage(r);
    });
    return () => {
      cancelled = true;
    };
  }, [probeUrl]);

  return (
    <div
      data-testid="media-load-error"
      className={cn(
        'border-destructive/40 bg-destructive/5 text-foreground flex items-start gap-2 rounded border p-3 text-sm',
        fill && 'h-full',
        className,
      )}
    >
      <ImageOff className="text-destructive icon-sm mt-0.5 shrink-0" />
      <div className="min-w-0">
        <div className="text-destructive font-medium">Couldn’t load media</div>
        <div className="text-muted-foreground break-words">{message}</div>
        {path && <div className="text-muted-foreground/70 mt-0.5 text-xs break-all">{path}</div>}
      </div>
    </div>
  );
}
