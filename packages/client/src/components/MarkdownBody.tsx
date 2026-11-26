import { Suspense, lazy, type ReactNode } from 'react';

import { linkIssueReferences } from '@/lib/github-issue-refs';
import {
  baseMarkdownComponents,
  markdownProseClassName,
  remarkPlugins,
} from '@/lib/markdown-components';

/** A body's links lead to GitHub or elsewhere: open them beside funny, not in its place. */
const bodyComponents = {
  ...baseMarkdownComponents,
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

const LazyMarkdown = lazy(() =>
  Promise.all([import('react-markdown'), import('rehype-raw'), import('rehype-sanitize')]).then(
    ([{ default: ReactMarkdown }, { default: rehypeRaw }, { default: rehypeSanitize }]) => ({
      default: function Md({ content }: { content: string }) {
        return (
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={[rehypeRaw, rehypeSanitize]}
            components={bodyComponents}
          >
            {content}
          </ReactMarkdown>
        );
      },
    }),
  ),
);

/** GitHub-flavoured markdown body (PR / issue descriptions and comments), sanitized. */
export function MarkdownBody({
  body,
  repoUrl,
}: {
  body: string | null | undefined;
  /** `https://github.com/owner/repo`: with it, `#123` links to that repository's item. */
  repoUrl?: string | null;
}) {
  const trimmed = linkIssueReferences((body ?? '').trim(), repoUrl ?? null);
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
