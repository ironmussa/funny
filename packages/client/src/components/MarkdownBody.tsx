import { Suspense, lazy } from 'react';

import {
  baseMarkdownComponents,
  markdownProseClassName,
  remarkPlugins,
} from '@/lib/markdown-components';

const LazyMarkdown = lazy(() =>
  Promise.all([import('react-markdown'), import('rehype-raw'), import('rehype-sanitize')]).then(
    ([{ default: ReactMarkdown }, { default: rehypeRaw }, { default: rehypeSanitize }]) => ({
      default: function Md({ content }: { content: string }) {
        return (
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={[rehypeRaw, rehypeSanitize]}
            components={baseMarkdownComponents}
          >
            {content}
          </ReactMarkdown>
        );
      },
    }),
  ),
);

/** GitHub-flavoured markdown body (PR / issue descriptions and comments), sanitized. */
export function MarkdownBody({ body }: { body: string | null | undefined }) {
  const trimmed = (body ?? '').trim();
  if (!trimmed) {
    return <span className="text-muted-foreground italic">(empty)</span>;
  }
  return (
    <div className={markdownProseClassName}>
      <Suspense fallback={<pre className="text-xs whitespace-pre-wrap">{trimmed}</pre>}>
        <LazyMarkdown content={trimmed} />
      </Suspense>
    </div>
  );
}
