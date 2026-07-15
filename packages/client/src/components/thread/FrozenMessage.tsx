import { memo, useContext, useEffect, useRef, useState } from 'react';

import { FrozenViewerContext } from './frozen-message-context';
import { MessageContent } from './MessageContent';

/**
 * Assistant-message content for the frozen viewer. Renders live Sätteri HTML
 * while near the viewport, and once scrolled far away freezes the browser's
 * sanitized markup — dropping the markdown component tree so memory stays
 * bounded by what is visible, not by thread length.
 *
 * The captured HTML is Sätteri output that already passed through DOMPurify, so
 * re-inserting it via `dangerouslySetInnerHTML` adds no
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
  // A content change must discard any previously captured markup. Using a key
  // gives React that reset at the component boundary rather than resetting
  // several pieces of state from an effect after an outdated frame has painted.
  return <FrozenMessageInstance key={content} content={content} />;
});

function FrozenMessageInstance({ content }: { content: string }) {
  const ctx = useContext(FrozenViewerContext);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const capturedHtmlRef = useRef<string | null>(null);
  const nearRef = useRef(true);
  const [mode, setMode] = useState<'live' | 'frozen'>('live');
  const [frozenHeight, setFrozenHeight] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    let retryTimer: number | undefined;

    const scheduleRetry = () => {
      if (retryTimer !== undefined) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        settle();
      }, 16);
    };

    const settle = () => {
      if (nearRef.current) {
        setMode('live');
        return;
      }
      // Far offscreen: capture the live HTML (if it has rendered) and freeze.
      if (capturedHtmlRef.current === null) {
        const el2 = wrapperRef.current;
        // Do not freeze the temporary plain-text loading state. Wait for
        // compiler HTML or the explicit safe error state instead.
        if (!el2?.querySelector('[data-testid="satteri-markdown"], [data-satteri-error]')) {
          scheduleRetry();
          return;
        }
        const html = el2?.innerHTML ?? '';
        if (html && el2?.firstElementChild) {
          capturedHtmlRef.current = html;
          // The static markup is semantically identical but can have a
          // slightly different box tree. Retain the live height while this
          // offscreen row is frozen so its replacement cannot move the rows
          // that remain in the viewport.
          setFrozenHeight(el2.getBoundingClientRect().height);
        }
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
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [content, ctx]);

  if (mode === 'frozen' && capturedHtmlRef.current !== null) {
    return (
      <div
        ref={wrapperRef}
        data-testid="frozen-message"
        data-frozen="true"
        style={frozenHeight !== null ? { height: frozenHeight } : undefined}
        // eslint-disable-next-line react-dom/no-dangerously-set-innerhtml -- sanitized Sätteri output, re-inserted verbatim
        dangerouslySetInnerHTML={{ __html: capturedHtmlRef.current }}
      />
    );
  }

  return (
    <div ref={wrapperRef} data-testid="frozen-message" data-frozen="false">
      <MessageContent content={content} />
    </div>
  );
}
