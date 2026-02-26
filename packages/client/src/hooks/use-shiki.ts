import { useState, useEffect, useRef, useCallback } from 'react';
import type { Highlighter } from 'shiki';

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>();

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then((mod) =>
      mod.createHighlighter({
        themes: ['github-dark-default'],
        langs: [],
      }),
    );
  }
  return highlighterPromise;
}

export function useShiki() {
  const [ready, setReady] = useState(false);
  const highlighterRef = useRef<Highlighter | null>(null);

  useEffect(() => {
    getHighlighter().then((h) => {
      highlighterRef.current = h;
      setReady(true);
    });
  }, []);

  const highlight = useCallback(async (code: string, lang: string): Promise<string> => {
    const h = highlighterRef.current;
    if (!h) return escapeHtml(code);

    if (lang !== 'text' && !loadedLangs.has(lang)) {
      try {
        await h.loadLanguage(lang as Parameters<Highlighter['loadLanguage']>[0]);
        loadedLangs.add(lang);
      } catch {
        lang = 'text';
      }
    }

    if (lang === 'text') {
      // For plain text, just wrap in shiki-compatible structure
      const escaped = escapeHtml(code);
      const lines = escaped
        .split('\n')
        .map((l) => `<span class="line">${l}</span>`)
        .join('\n');
      return `<pre class="shiki github-dark-default" style="background-color:transparent"><code>${lines}</code></pre>`;
    }

    return h.codeToHtml(code, { lang, theme: 'github-dark-default' });
  }, []);

  return { ready, highlight };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
