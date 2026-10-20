/**
 * Warm the module cache for the markdown pipeline that PR conversation
 * comments load through `React.lazy`. Under a loaded full-suite run the first
 * transform of these modules can take longer than any `findBy*` wait, so tests
 * that assert on rendered markdown preload them in `beforeAll` instead.
 */
export async function preloadMarkdownPipeline(): Promise<void> {
  await Promise.all([import('react-markdown'), import('rehype-raw'), import('rehype-sanitize')]);
}

export const MARKDOWN_PRELOAD_TIMEOUT_MS = 60_000;
