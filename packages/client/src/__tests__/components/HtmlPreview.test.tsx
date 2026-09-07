import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { HtmlPreview } from '@/components/HtmlPreview';
import { MonacoEditorDialog } from '@/components/MonacoEditorDialog';
import { TooltipProvider } from '@/components/ui/tooltip';
import { buildHtmlPreview, isHtmlFile } from '@/lib/html-preview';

vi.mock('@/lib/api', () => ({
  api: {
    getFileBlame: vi.fn(async () => ({ isOk: () => false, error: { message: 'untracked' } })),
    getFileHistory: vi.fn(async () => ({ isOk: () => true, value: [] })),
  },
}));
vi.mock('@/components/MonacoCodeView', () => ({
  MonacoCodeView: ({ content }: { content: string }) => (
    <pre data-testid="code-view">{content}</pre>
  ),
}));

afterEach(cleanup);

function previewDoc(content: string, path = '/project/report/index.html') {
  return new DOMParser().parseFromString(buildHtmlPreview(content, path), 'text/html');
}

describe('HTML file preview', () => {
  test('recognizes HTML and HTM case-insensitively without matching other files', () => {
    expect(isHtmlFile('/project/REPORT.HTML')).toBe(true);
    expect(isHtmlFile('/project/report.htm')).toBe(true);
    expect(isHtmlFile('/project/report.html.txt')).toBe(false);
  });

  test('preserves document styling and resolves local images and links', () => {
    const doc = previewDoc(`<style>body { color: red }</style><h1>Report</h1>
      <a href="shot%201.jpg"><img src="../images/shot%201.jpg"></a>
      <img src="https://example.com/image.jpg"><a href="#details">Details</a>`);
    expect(doc.querySelector('h1')?.textContent).toBe('Report');
    expect(doc.querySelector('style')?.textContent).toContain('color: red');
    const src = new URL(doc.querySelector('img')!.getAttribute('src')!);
    expect(src.pathname).toBe('/api/files/raw');
    expect(src.searchParams.get('path')).toBe('/project/images/shot 1.jpg');
    expect(new URL(doc.querySelector('a')!.href).searchParams.get('path')).toBe(
      '/project/report/shot 1.jpg',
    );
    expect(doc.querySelectorAll('img')[1].getAttribute('src')).toBe(
      'https://example.com/image.jpg',
    );
    expect(doc.querySelectorAll('a')[1].getAttribute('href')).toBe('#details');
  });

  test('handles literal percent signs in local asset names', () => {
    const doc = previewDoc('<img src="100%.png">');
    expect(new URL(doc.querySelector('img')!.src).searchParams.get('path')).toBe(
      '/project/report/100%.png',
    );
  });

  test('resolves inline CSS assets and Windows paths', () => {
    const doc = previewDoc('<div style="background: url(bg.png)"></div>', 'C:\\project\\index.htm');
    expect(doc.querySelector('div')?.getAttribute('style')).toContain('C%3A%2Fproject%2Fbg.png');
  });

  test('retains the app origin for authenticated local images without enabling scripts', () => {
    render(
      <HtmlPreview content='<img src="shot-01-0.jpg">' filePath="/project/report/index.html" />,
    );
    const frame = screen.getByTestId('html-preview');
    // An opaque sandbox origin drops the server's SameSite=Strict session cookie.
    expect(frame).toHaveAttribute('sandbox', 'allow-same-origin');
    const doc = new DOMParser().parseFromString(frame.getAttribute('srcdoc')!, 'text/html');
    const imageUrl = new URL(doc.querySelector('img')!.getAttribute('src')!);
    expect(imageUrl.origin).toBe(window.location.origin);
    expect(imageUrl.searchParams.get('path')).toBe('/project/report/shot-01-0.jpg');
  });

  test('isolates HTML and blocks scripts, forms, embedded frames and automatic redirects', () => {
    const content =
      '<base href="https://example.com/"><meta http-equiv="refresh" content="0;url=/"><script>parent.alert(1)</script><h1>Report</h1>';
    render(<HtmlPreview content={content} filePath="/project/index.html" />);
    const frame = screen.getByTestId('html-preview');
    expect(frame).toHaveAttribute('sandbox', 'allow-same-origin');
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    const doc = previewDoc(content);
    expect(doc.querySelector('base')).toBeNull();
    expect(doc.querySelectorAll('meta[http-equiv]')).toHaveLength(1);
    expect(doc.head.firstElementChild?.getAttribute('content')).toContain("default-src 'none'");
    expect(doc.head.firstElementChild?.getAttribute('content')).toContain("form-action 'none'");
  });

  test('opens HTML rendered by default and allows switching to source and back', async () => {
    render(
      <TooltipProvider>
        <MonacoEditorDialog
          open
          onOpenChange={() => {}}
          filePath="/project/index.html"
          initialContent="<h1>Report</h1>"
        />
      </TooltipProvider>,
    );
    expect(screen.getByTestId('html-preview')).toHaveAttribute(
      'srcdoc',
      expect.stringContaining('<h1>Report</h1>'),
    );
    fireEvent.click(screen.getByTestId('editor-toggle-preview'));
    expect(await screen.findByTestId('code-view')).toHaveTextContent('<h1>Report</h1>');
    expect(screen.queryByTestId('html-preview')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('editor-toggle-preview'));
    expect(screen.getByTestId('html-preview')).toBeInTheDocument();
  });
});
