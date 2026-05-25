import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { browserSessionClient } from '@/lib/browser-session-client';
import { isTauriAnnotatorAvailable, openAnnotator } from '@/lib/tauri-annotator';
import { metric } from '@/lib/telemetry';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';
import {
  PROSE_FONT_SIZE_PX,
  PROSE_LINE_HEIGHT_PX,
  useSettingsStore,
} from '@/stores/settings-store';

// Only http(s) are recognised as user-supplied schemes. Anything else —
// including hostnames with ports (`localhost:5173`), the user typing
// `apt:firefox`, or hostile schemes like `file:`, `javascript:`, `data:`,
// `mailto:`, `magnet:` — gets `http://` prepended and re-validated. This
// prevents the runner from triggering OS-level URL handlers (on Linux, e.g.,
// `apt:` opens the package manager; on macOS / Windows similar handlers exist
// for various schemes).
const HTTP_SCHEME_RE = /^https?:\/\//i;

function normalizeUrl(input: string): { url: string; protocol: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = HTTP_SCHEME_RE.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    // Defense-in-depth: if the URL parser somehow inferred a non-http(s)
    // protocol (shouldn't happen after our prefix step, but URL parsing has
    // surprising corners), bail out so CDP never sees it.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (!parsed.hostname) return null;
    return { url: parsed.toString(), protocol: parsed.protocol.replace(':', '') };
  } catch {
    return null;
  }
}

export function BrowserUrlBar() {
  const url = useBrowserPanelStore((s) => s.url);
  const loadedUrl = useBrowserPanelStore((s) => s.loadedUrl);
  const loadError = useBrowserPanelStore((s) => s.loadError);
  const setUrl = useBrowserPanelStore((s) => s.setUrl);
  const openBrowserSession = useBrowserPanelStore((s) => s.openBrowserSession);
  const sessionId = useBrowserPanelStore((s) => s.sessionId);
  const sessionError = useBrowserPanelStore((s) => s.sessionError);
  const fontSize = useSettingsStore((s) => s.fontSize);

  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const result = normalizeUrl(url);
    if (!result) {
      setError('Enter a URL.');
      return;
    }
    setError(null);
    void openBrowserSession(result.url);
    metric('browser_panel.url_loaded', 1, {
      type: 'sum',
      attributes: { protocol: result.protocol },
    });
  };

  // Browser-style navigation. All three buttons call CDP `Page.*` directly via
  // the runner instead of `Runtime.evaluate('history.back()')` so SPAs that
  // shadow `window.history` don't break them. The session must be live for
  // the buttons to do anything.
  const canNavigate = !!loadedUrl && !!sessionId;

  const goBack = () => {
    if (!canNavigate) return;
    void browserSessionClient.nav(sessionId!, 'back').catch(() => {});
  };

  const goForward = () => {
    if (!canNavigate) return;
    void browserSessionClient.nav(sessionId!, 'forward').catch(() => {});
  };

  const reload = () => {
    if (!canNavigate) return;
    void browserSessionClient.nav(sessionId!, 'reload').catch(() => {});
  };

  const fontStyle = {
    fontSize: PROSE_FONT_SIZE_PX[fontSize],
    lineHeight: `${PROSE_LINE_HEIGHT_PX[fontSize]}px`,
  };

  const annotatorAvailable = isTauriAnnotatorAvailable();
  const handleOpenAnnotator = async () => {
    const result = normalizeUrl(url || loadedUrl || '');
    if (!result) {
      setError('Enter a URL first.');
      return;
    }
    setError(null);
    try {
      await openAnnotator(result.url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Annotator failed: ${msg}`);
    }
  };

  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <form onSubmit={handleSubmit} className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              tabIndex={-1}
              data-testid="browser-panel-back"
              disabled={!canNavigate}
              onClick={goBack}
              className="text-muted-foreground"
            >
              <ArrowLeft className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Back</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              tabIndex={-1}
              data-testid="browser-panel-forward"
              disabled={!canNavigate}
              onClick={goForward}
              className="text-muted-foreground"
            >
              <ArrowRight className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Forward</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              tabIndex={-1}
              data-testid="browser-panel-reload"
              disabled={!canNavigate}
              onClick={reload}
              className="text-muted-foreground"
            >
              <RotateCw className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Reload</TooltipContent>
        </Tooltip>
        <Input
          data-testid="browser-panel-url-input"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="http://localhost:5173"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="h-8 flex-1"
          style={fontStyle}
        />
        <Button
          type="submit"
          data-testid="browser-panel-url-go"
          size="sm"
          className="h-8 px-3"
          style={fontStyle}
        >
          Go
        </Button>
        {annotatorAvailable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                tabIndex={-1}
                data-testid="browser-panel-open-annotator"
                onClick={handleOpenAnnotator}
                className="text-muted-foreground"
              >
                <ExternalLink className="icon-base" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Open in annotator window (any origin)</TooltipContent>
          </Tooltip>
        )}
      </form>
      {(loadError || error || sessionError) && (
        <div
          role="alert"
          data-testid="browser-panel-url-error"
          className="text-destructive"
          style={fontStyle}
        >
          {loadError ?? error ?? sessionError}
        </div>
      )}
    </div>
  );
}
