import { useEffect, useMemo, useRef, useState } from 'react';

import { getCssVar } from '@/components/terminal/xterm-utils';
import { createAnsiConverter } from '@/lib/ansi-to-html';
import { jobsApi } from '@/lib/api/jobs';
import { cn } from '@/lib/utils';
import { useTerminalStore } from '@/stores/terminal-store';

/** Background job log tab — polls captured logfile chunks by byte offset. */
export function JobLogTabContent({
  tabId,
  jobId,
  active,
}: {
  tabId: string;
  jobId: string;
  active: boolean;
}) {
  const [output, setOutput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const offsetRef = useRef(0);
  const doneRef = useRef(false);
  const readingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const ansiConverter = useMemo(
    () =>
      createAnsiConverter({
        fg: getCssVar('--foreground'),
        bg: getCssVar('--background'),
        newline: true,
      }),
    [],
  );

  const htmlOutput = useMemo(() => {
    if (error) return ansiConverter.toHtml(error);
    return output ? ansiConverter.toHtml(output) : 'Waiting for output...';
  }, [ansiConverter, error, output]);

  useEffect(() => {
    let cancelled = false;

    const readOnce = async () => {
      if (readingRef.current || doneRef.current) return;
      readingRef.current = true;
      await jobsApi.readLog(jobId, offsetRef.current).match(
        (chunk) => {
          if (cancelled) return;
          if (chunk.output) setOutput((prev) => prev + chunk.output);
          offsetRef.current = chunk.offset;
          setError(null);

          if (chunk.status !== 'running' && chunk.offset >= chunk.size) {
            doneRef.current = true;
            useTerminalStore.getState().markExited(tabId);
          }
        },
        (err) => {
          if (cancelled) return;
          doneRef.current = true;
          setError(err.friendlyMessage ?? err.message);
          useTerminalStore.getState().markExited(tabId);
        },
      );
      readingRef.current = false;
    };

    void readOnce();
    const timer = window.setInterval(() => void readOnce(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [jobId, tabId]);

  useEffect(() => {
    if (active && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [output, active]);

  return (
    <div
      className={cn(
        'absolute inset-0 flex flex-col bg-background',
        active ? 'z-10' : 'z-0 invisible pointer-events-none',
      )}
    >
      <div ref={scrollRef} className="flex-1 overflow-auto px-3 py-1">
        <pre
          className="font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap text-[#fafafa]"
          dangerouslySetInnerHTML={{ __html: htmlOutput }}
        />
      </div>
    </div>
  );
}
