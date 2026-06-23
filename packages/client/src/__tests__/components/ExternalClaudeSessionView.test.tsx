import { screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

const messageStreamMock = vi.fn((props: any) => (
  <div data-testid="shared-message-stream">
    {JSON.stringify(props.messages)}
    {props.footer}
  </div>
));
const promptInputMock = vi.fn((props: any) => (
  <div data-testid="external-prompt-input">{props.placeholder}</div>
));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@/components/thread/MessageStream', () => ({
  MessageStream: (props: any) => messageStreamMock(props),
}));

vi.mock('@/components/PromptInput', () => ({
  PromptInput: (props: any) => promptInputMock(props),
}));

vi.mock('@/lib/api', () => ({
  api: {
    getExternalClaudeTranscript: vi.fn(),
  },
}));

const [{ ExternalClaudeSessionView }, { api }] = await Promise.all([
  import('@/components/ExternalClaudeSessionView'),
  import('@/lib/api'),
]);

describe('ExternalClaudeSessionView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getExternalClaudeTranscript).mockReturnValue(
      okAsync({
        transcript: {
          sessionId: 'session-1',
          cwd: '/work/funny',
          projectName: 'funny',
          gitBranch: 'feature/external',
          title: 'continue the refactor',
          startedAt: '2026-06-23T12:00:00.000Z',
          updatedAt: '2026-06-23T12:01:00.000Z',
          messages: [
            {
              id: 'u1',
              role: 'user',
              content: 'Please continue',
              timestamp: '2026-06-23T12:00:00.000Z',
            },
            {
              id: 'a1',
              role: 'assistant',
              content: 'Working on it',
              timestamp: '2026-06-23T12:00:05.000Z',
            },
            {
              id: 'a2',
              role: 'assistant',
              content: '',
              timestamp: '2026-06-23T12:00:06.000Z',
              toolCalls: [
                {
                  id: 'tool-1',
                  name: 'Read',
                  input: '{ "file_path": "README.md" }',
                  output: 'Tool result',
                  timestamp: '2026-06-23T12:00:06.000Z',
                  author: 'Claude Code',
                },
              ],
            },
          ],
        },
      }),
    );
  });

  test('renders external transcripts through the shared thread message stream', async () => {
    renderWithProviders(<ExternalClaudeSessionView sessionId="session-1" />);

    expect(await screen.findByTestId('shared-message-stream')).toBeInTheDocument();

    await waitFor(() => {
      expect(messageStreamMock).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'external-claude:session-1',
          status: 'running',
          isExternal: true,
        }),
      );
    });

    const props = messageStreamMock.mock.calls.at(-1)?.[0];
    expect(props.messages).toMatchObject([
      { id: 'u1', role: 'user', content: 'Please continue' },
      { id: 'a1', role: 'assistant', content: 'Working on it' },
      {
        id: 'a2',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'tool-1',
            messageId: 'a2',
            name: 'Read',
            input: '{ "file_path": "README.md" }',
            output: 'Tool result',
            author: 'Claude Code',
            timestamp: '2026-06-23T12:00:06.000Z',
          },
        ],
      },
    ]);
    expect(screen.queryByText('externalClaude.sessionId')).not.toBeInTheDocument();
    expect(screen.getByTestId('external-claude-title')).toHaveTextContent('continue the refactor');
    expect(screen.getByTestId('external-prompt-input')).toHaveTextContent(
      'Continue in Claude Code...',
    );
    expect(promptInputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        running: false,
        queuedCount: 0,
        threadOverride: expect.objectContaining({
          provider: 'claude',
          permissionMode: 'auto',
          branch: 'feature/external',
          worktreePath: '/work/funny',
          queuedCount: 0,
        }),
      }),
    );
  });
});
