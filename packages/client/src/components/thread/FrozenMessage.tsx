import { memo, useContext, useEffect, useRef, useState } from 'react';

import { FrozenViewerContext } from './frozen-message-context';
import { MessageContent } from './MessageContent';

/**
 * Assistant-message content for the frozen viewer. Renders live `MessageContent`
 * (react-markdown) while near the viewport, and once scrolled far away freezes
 * to the HTML the browser already rendered — dropping the react-markdown fiber
 * tree so memory stays bounded by what is visible, not by thread length.
 *
 * The captured HTML is react-markdown's own output, which already passed through
 * `rehype-sanitize`, so re-inserting it via `dangerouslySetInnerHTML` adds no
 * XSS surface. Interactivity (copy button, file links) lives on the row chrome
 * and on live rows; a frozen row is offscreen by definition and rehydrates to
 * live React before it can be interacted with. Frozen HTML stays in the DOM, so
 * find-in-page still reaches it.
 *
 * Bootstrap: a row renders live first (even offscreen — `content-visibility`
 * skips its paint), then freezes a couple frames later once its markdown has
 * settled. Rows re-hydrate to live React when they scroll back near.
 */
// How far outside the viewport a message stays live before freezing. Generous
// so scrolling does not thrash the live<->frozen swap near the fold.
const FREEZE_MARGIN_PX = 1500;

export const FrozenMessage = memo(function FrozenMessage({ content }: { content: string }) {
  const ctx = useContext(FrozenViewerContext);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const capturedHtmlRef = useRef<string | null>(null);
  const nearRef = useRef(true);
  const [mode, setMode] = useState<'live' | 'frozen'>('live');

  // Reset when the message content changes (e.g. edit) — a stale capture would
  // otherwise freeze the previous text.
  useEffect(() => {
    capturedHtmlRef.current = null;
    setMode('live');
  }, [content]);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const settle = () => {
      if (nearRef.current) {
        setMode('live');
        return;
      }
      // Far offscreen: capture the live HTML (if it has rendered) and freeze.
      if (capturedHtmlRef.current === null) {
        const el2 = wrapperRef.current;
        const html = el2?.innerHTML ?? '';
        if (html && el2?.firstElementChild) capturedHtmlRef.current = html;
      }
      if (capturedHtmlRef.current !== null) setMode('frozen');
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          nearRef.current = entry.isIntersecting;
        }
        settle();
      },
      { root: ctx?.scrollRootRef.current ?? null, rootMargin: `${FREEZE_MARGIN_PX}px 0px` },
    );
    observer.observe(el);

    // Post-mount capture pass: markdown settles within a frame or two (its chunk
    // is prefetched), so an initially-offscreen row can freeze without ever
    // being scrolled to.
    const raf = requestAnimationFrame(() => requestAnimationFrame(settle));

    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [content, ctx]);

  if (mode === 'frozen' && capturedHtmlRef.current !== null) {
    return (
      <div
        ref={wrapperRef}
        data-testid="frozen-message"
        data-frozen="true"
        // eslint-disable-next-line react-dom/no-dangerously-set-innerhtml -- sanitized react-markdown output, re-inserted verbatim
        dangerouslySetInnerHTML={{ __html: capturedHtmlRef.current }}
      />
    );
  }

  return (
    <div ref={wrapperRef} data-testid="frozen-message" data-frozen="false">
      <MessageContent content={content} />
    </div>
  );
});
