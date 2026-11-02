import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import {
  browserRecordingPath,
  getMcpCodeInput,
  getMcpSummary,
  mcpResultPreview,
  mcpToolTitle,
  parseMcpResult,
  parseMcpToolName,
} from '@/components/tool-cards/mcp-tool';
import { McpToolCard } from '@/components/tool-cards/McpToolCard';

import { renderWithProviders } from '../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

// The output the screenshot showed as raw JSON: one markdown text block plus meta.
const ENVELOPE = JSON.stringify({
  content: [
    {
      type: 'text',
      text: '# Browser Interaction Troubleshooting\n- Do not inspect browser-use source code.\n- Keep the existing browser binding.',
    },
  ],
  _meta: { 'codex/nodeReplExecutionDurationMs': 1 },
  structured_content: null,
});

describe('mcp-tool helpers', () => {
  test('splits server and tool, keeping underscores inside the server name', () => {
    expect(parseMcpToolName('mcp__cua_repl__js')).toEqual({ server: 'cua_repl', tool: 'js' });
    expect(parseMcpToolName('mcp__github__create_pull_request')).toEqual({
      server: 'github',
      tool: 'create_pull_request',
    });
    expect(parseMcpToolName('Bash')).toBeNull();
    expect(parseMcpToolName('mcp__broken')).toBeNull();
  });

  test('titles are friendly: known actions, humanized ids, server prefix dropped', () => {
    const t = (key: string) => key;
    expect(mcpToolTitle({ server: 'funny', tool: 'funny_spawn' }, t)).toBe(
      'funny · tools.mcp.backgroundJob',
    );
    expect(mcpToolTitle({ server: 'linear', tool: 'get_issue' }, t)).toBe('Linear · Get issue');
    expect(mcpToolTitle({ server: 'codegraph', tool: 'codegraph_search' }, t)).toBe(
      'CodeGraph · Search',
    );
    expect(mcpToolTitle({ server: 'convex', tool: 'runOneoffQuery' }, t)).toBe(
      'Convex · Run oneoff query',
    );
    expect(mcpToolTitle({ server: 'my-server', tool: 'do_it' }, t)).toBe('My Server · Do it');
  });

  test('browser dialog, appearance and recording tools have titles and summaries', () => {
    const t = (key: string) => key;
    const browser = (tool: string) => ({ server: 'funny_browser', tool });
    expect(mcpToolTitle(browser('browser_recording_stop'), t)).toMatch(
      / · tools\.mcp\.browserRecordingStop$/,
    );
    expect(getMcpSummary({ accept: false }, browser('browser_dialog'))?.text).toBe('dismiss');
    expect(
      getMcpSummary({ accept: true, promptText: 'Ada' }, browser('browser_dialog'))?.text,
    ).toBe('accept · "Ada"');
    expect(getMcpSummary({ colorScheme: 'dark' }, browser('browser_set_appearance'))?.text).toBe(
      'dark',
    );
    expect(
      getMcpSummary({ action: 'upload', ref: 'e4', paths: ['a.png'] }, browser('browser_act'))
        ?.text,
    ).toBe('upload e4 · a.png');
  });

  test('the recording path is read only from browser_recording_stop results', () => {
    const text = 'Recording saved: /home/u/.funny/assets/rec.mp4\n3s, 40 frames.';
    expect(
      browserRecordingPath({ server: 'funny_browser', tool: 'browser_recording_stop' }, text),
    ).toBe('/home/u/.funny/assets/rec.mp4');
    expect(browserRecordingPath({ server: 'funny_browser', tool: 'browser_status' }, text)).toBe(
      null,
    );
  });

  test('summary prefers the title; code input takes its language from the tool', () => {
    const parsed = { code: 'nodeRepl.write(1)', title: 'Resolve the Cloudflare panel' };
    expect(getMcpSummary(parsed)).toEqual({ key: 'title', text: 'Resolve the Cloudflare panel' });
    expect(getMcpCodeInput(parsed, 'js')).toEqual({
      key: 'code',
      code: 'nodeRepl.write(1)',
      language: 'javascript',
    });
    expect(getMcpCodeInput({ sql: 'select 1' }, 'run')?.language).toBe('sql');
    expect(getMcpCodeInput({ title: 'x' }, 'js')).toBeNull();
  });

  test('parses the MCP envelope into parts, duration and error flag', () => {
    const result = parseMcpResult(ENVELOPE)!;
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({ kind: 'text', markdown: true });
    expect(result.durationMs).toBe(1);
    expect(result.isError).toBe(false);
    expect(result.structured).toBeNull();
    expect(mcpResultPreview(result)).toBe('Browser Interaction Troubleshooting');

    const failed = parseMcpResult(
      JSON.stringify({ content: [{ type: 'text', text: 'boom' }], isError: true }),
    )!;
    expect(failed.isError).toBe(true);
  });

  test('anything that is not an MCP envelope is left to the raw view', () => {
    expect(parseMcpResult('plain text')).toBeNull();
    expect(parseMcpResult('{"ok": true}')).toBeNull();
    expect(parseMcpResult('{"content": [{"type": "mystery"}]}')).toBeNull();
    expect(parseMcpResult('{not json')).toBeNull();
  });

  test('images only inline as image data URLs', () => {
    const ok = parseMcpResult(
      JSON.stringify({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }),
    )!;
    expect(ok.parts[0]).toEqual({
      kind: 'image',
      src: 'data:image/png;base64,AAAA',
      mimeType: 'image/png',
    });
    expect(
      parseMcpResult(
        JSON.stringify({ content: [{ type: 'image', data: 'AAAA', mimeType: 'text/html' }] }),
      ),
    ).toBeNull();
  });
});

describe('McpToolCard', () => {
  const props = {
    mcp: { server: 'cua_repl', tool: 'js' },
    parsed: { code: 'nodeRepl.write(1)', title: 'Resolve the Cloudflare panel' },
    output: ENVELOPE,
    displayTime: '1m',
  };

  test('header shows server, tool, title, duration and a readable preview', () => {
    renderWithProviders(<McpToolCard {...props} />);
    expect(screen.getByText('REPL · tools.mcp.runJavaScript')).toBeInTheDocument();
    expect(screen.getByText('Resolve the Cloudflare panel')).toBeInTheDocument();
    expect(screen.getByText('1ms')).toBeInTheDocument();
    expect(screen.getByText('→ Browser Interaction Troubleshooting')).toBeInTheDocument();
  });

  test('expanded, the result is rendered as content and the raw JSON is one click away', () => {
    renderWithProviders(<McpToolCard {...props} />);
    fireEvent.click(screen.getByTestId('mcp-tool-card-toggle'));
    expect(screen.queryByText(/"_meta"/)).not.toBeInTheDocument();
    expect(screen.getByText(/Keep the existing browser binding/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('mcp-tool-card-raw-toggle'));
    expect(screen.getByText(/_meta/)).toBeInTheDocument();
  });

  test('an error result is flagged in the header', () => {
    renderWithProviders(
      <McpToolCard
        {...props}
        output={JSON.stringify({ content: [{ type: 'text', text: 'boom' }], isError: true })}
      />,
    );
    expect(screen.getByTestId('mcp-tool-card-error')).toBeInTheDocument();
  });

  test('a saved browser recording is previewed as a video', () => {
    const output = JSON.stringify({
      content: [{ type: 'text', text: 'Recording saved: /tmp/assets/rec.mp4\n2s, 12 frames.' }],
    });
    renderWithProviders(
      <McpToolCard
        mcp={{ server: 'funny_browser', tool: 'browser_recording_stop' }}
        parsed={{}}
        output={output}
        displayTime={null}
      />,
    );
    fireEvent.click(screen.getByTestId('mcp-tool-card-toggle'));
    const preview = screen.getByTestId('media-preview');
    expect(preview).toHaveAttribute('data-media-kind', 'video');
    expect(preview.querySelector('video')?.getAttribute('src')).toBe(
      '/api/files/raw?path=%2Ftmp%2Fassets%2Frec.mp4',
    );
  });
});
