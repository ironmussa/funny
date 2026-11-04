/**
 * Characterization tests for the PromptInputUI submit pipeline. They pin the
 * exact `onSubmit` payload and the early-exit branches of `handleSubmit` so the
 * component can be split into hooks/helpers without behavior drift.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { errAsync, okAsync } from 'neverthrow';
import { toast } from 'sonner';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { PromptInputUI, type PromptInputUIProps } from '@/components/PromptInputUI';
import { seedTemplates } from '@/data/templates/testing';
import { systemApi } from '@/lib/api/system';
import { threadsApi } from '@/lib/api/threads';

import { renderWithProviders } from '../helpers/render';

const executeCodexCommand = vi.fn();

vi.mock('@/hooks/use-codex-commands', () => ({
  useCodexCommands: () => executeCodexCommand,
}));

vi.mock('@/lib/api/system', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/system')>();
  return {
    ...actual,
    systemApi: { ...actual.systemApi, providerSetupStatus: vi.fn() },
  };
});

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { defaultValue?: string }) =>
      typeof fallback === 'string' ? fallback : (fallback?.defaultValue ?? key),
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@/components/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('@/components/ProviderSetupDialog', () => ({
  ProviderSetupDialog: () => <div data-testid="provider-setup-dialog" />,
}));
vi.mock('@/components/PromptSelectors', () => ({
  ModelSelect: () => null,
  ModeSelect: () => null,
  TemplateSelect: () => null,
}));

vi.mock('@/components/prompt-editor/PromptEditor', () => {
  const { forwardRef, useImperativeHandle, useRef, useState } = require('react');
  return {
    PromptEditor: forwardRef(function MockPromptEditor(props: any, ref: any) {
      const [value, setValue] = useState('');
      const valueRef = useRef(value);
      valueRef.current = value;
      useImperativeHandle(ref, () => ({
        getJSON: () => ({ text: valueRef.current }),
        setContent: (content: any) => {
          const text = typeof content === 'string' ? content : (content?.text ?? '');
          valueRef.current = text;
          setValue(text);
        },
        focus: () => {},
        clear: () => {
          valueRef.current = '';
          setValue('');
        },
        isEmpty: () => !valueRef.current,
      }));
      return (
        <textarea
          data-testid="prompt-editor"
          value={value}
          onChange={(e: any) => {
            valueRef.current = e.target.value;
            setValue(e.target.value);
            props.onChange?.();
          }}
          onKeyDown={(e: any) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              props.onSubmit?.();
            }
          }}
          disabled={props.disabled}
        />
      );
    }),
  };
});

vi.mock('@/components/prompt-editor/serialize', () => ({
  serializeEditorContent: (json: any) => ({
    text: json?.text ?? '',
    fileReferences: json?.text?.includes('@file') ? [{ path: 'src/a.ts', type: 'file' }] : [],
    symbolReferences: json?.text?.includes('@sym')
      ? [{ path: 'src/a.ts', name: 'foo', kind: 'function', line: 1 }]
      : [],
  }),
}));

const IMAGE = {
  type: 'image' as const,
  source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'ZmFrZQ==' },
};

function renderUI(props: Partial<PromptInputUIProps> = {}) {
  const onSubmit = (props.onSubmit ?? vi.fn()) as ReturnType<
    typeof vi.fn<PromptInputUIProps['onSubmit']>
  >;
  renderWithProviders(
    <PromptInputUI
      unifiedModel="claude:opus"
      onUnifiedModelChange={vi.fn()}
      modelGroups={[]}
      mode="autoEdit"
      onModeChange={vi.fn()}
      modes={[{ value: 'autoEdit', label: 'Auto' }]}
      {...props}
      onSubmit={onSubmit}
    />,
  );
  return { onSubmit, editor: screen.getByTestId('prompt-editor') as HTMLTextAreaElement };
}

function type(editor: HTMLTextAreaElement, text: string) {
  fireEvent.change(editor, { target: { value: text } });
}

function submit(editor: HTMLTextAreaElement) {
  fireEvent.keyDown(editor, { key: 'Enter' });
}

async function attachTextFile(name: string, content: string) {
  const input = screen.getByTestId('prompt-file-input') as HTMLInputElement;
  const file = new File([content], name, { type: 'text/plain' });
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByTestId('prompt-attached-file-0');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(systemApi.providerSetupStatus).mockReturnValue(
    okAsync({
      provider: 'claude',
      state: 'installed',
      auth: 'connected',
      installable: true,
      login: null,
    }) as any,
  );
  seedTemplates([]);
});

describe('PromptInputUI submit', () => {
  test('follow-up submit sends the follow-up branch and no new-thread options', async () => {
    const { onSubmit, editor } = renderUI({ followUpSelectedBranch: 'feat/x', effort: 'high' });
    type(editor, 'hello');
    submit(editor);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      'hello',
      {
        provider: 'claude',
        model: 'opus',
        mode: 'autoEdit',
        effort: 'high',
        baseBranch: 'feat/x',
        fileReferences: undefined,
        symbolReferences: undefined,
      },
      undefined,
    );
    expect(editor.value).toBe('');
  });

  test('new thread submit sends thread mode, runtime, branch and backlog flag', async () => {
    const { onSubmit, editor } = renderUI({
      isNewThread: true,
      createWorktree: true,
      runtime: 'remote',
      selectedBranch: 'main',
      sendToBacklog: true,
    });
    type(editor, 'build it @file @sym');
    submit(editor);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][1]).toEqual({
      provider: 'claude',
      model: 'opus',
      mode: 'autoEdit',
      effort: undefined,
      threadMode: 'worktree',
      runtime: 'remote',
      baseBranch: 'main',
      sendToBacklog: true,
      agentTemplateId: undefined,
      templateVariables: undefined,
      fileReferences: [{ path: 'src/a.ts', type: 'file' }],
      symbolReferences: [{ path: 'src/a.ts', name: 'foo', kind: 'function', line: 1 }],
    });
  });

  test('local new thread runs checkout preflight and aborts when it fails', async () => {
    const onCheckoutPreflight = vi.fn().mockResolvedValue(false);
    const { onSubmit, editor } = renderUI({
      isNewThread: true,
      selectedBranch: 'dev',
      onCheckoutPreflight,
    });
    type(editor, 'task');
    submit(editor);
    await waitFor(() => expect(onCheckoutPreflight).toHaveBeenCalledWith('dev'));
    await new Promise((r) => setTimeout(r, 0));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(editor.value).toBe('task');
  });

  test('worktree new thread skips checkout preflight', async () => {
    const onCheckoutPreflight = vi.fn().mockResolvedValue(false);
    const { onSubmit, editor } = renderUI({
      isNewThread: true,
      createWorktree: true,
      selectedBranch: 'dev',
      onCheckoutPreflight,
    });
    type(editor, 'task');
    submit(editor);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onCheckoutPreflight).not.toHaveBeenCalled();
  });

  test('leading slash command resolves thread mode from loaded skills', async () => {
    const loadSkills = vi
      .fn()
      .mockResolvedValue([{ name: 'ship', kind: 'skill', threadMode: 'worktree' }]);
    const onCheckoutPreflight = vi.fn().mockResolvedValue(true);
    const { onSubmit, editor } = renderUI({
      isNewThread: true,
      selectedBranch: 'dev',
      loadSkills,
      onCheckoutPreflight,
    });
    type(editor, '/ship now');
    submit(editor);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(loadSkills).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][1].threadMode).toBe('worktree');
    expect(onCheckoutPreflight).not.toHaveBeenCalled();
  });

  test('scratch threads ignore the slash command thread mode', async () => {
    const loadSkills = vi
      .fn()
      .mockResolvedValue([{ name: 'ship', kind: 'skill', threadMode: 'worktree' }]);
    const { onSubmit, editor } = renderUI({ isNewThread: true, isScratch: true, loadSkills });
    type(editor, '/ship now');
    submit(editor);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][1].threadMode).toBe('local');
  });

  test('inline text files are prepended as a referenced-files block', async () => {
    const { onSubmit, editor } = renderUI();
    await attachTextFile('a"b.txt', 'file body');
    type(editor, 'see file');
    submit(editor);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toBe(
      '<referenced-files>\n<file path="a&quot;b.txt">\nfile body\n</file>\n</referenced-files>\n\nsee file',
    );
    expect(screen.queryByTestId('prompt-attached-file-0')).toBeNull();
  });

  test('a binary file attached before the thread exists is staged and sent as stagedUploads', async () => {
    const stageUpload = vi
      .spyOn(threadsApi, 'stageUpload')
      .mockReturnValue(okAsync({ stagedId: 'staged-1', name: 'spec.pdf', size: 4 }) as never);
    const uploadFile = vi.spyOn(threadsApi, 'uploadFile');
    const { onSubmit, editor } = renderUI({ isNewThread: true, projectId: 'p-1' });

    const input = screen.getByTestId('prompt-file-input') as HTMLInputElement;
    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'spec.pdf', {
      type: 'application/pdf',
    });
    fireEvent.change(input, { target: { files: [pdf] } });
    await waitFor(() => expect(stageUpload).toHaveBeenCalledTimes(1));
    expect(stageUpload.mock.calls[0][0]).toMatchObject({ filename: 'spec.pdf' });
    expect(stageUpload.mock.calls[0][1]).toBe('p-1');
    expect(uploadFile).not.toHaveBeenCalled();
    await screen.findByTestId('prompt-attached-file-0');

    type(editor, 'read the spec');
    submit(editor);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // Never inlined as text: the prompt carries no referenced-files block.
    expect(onSubmit.mock.calls[0][0]).toBe('read the spec');
    expect(onSubmit.mock.calls[0][1].stagedUploads).toEqual(['staged-1']);
  });

  test('restores images and text files when onSubmit returns false', async () => {
    const { onSubmit, editor } = renderUI({
      onSubmit: vi.fn().mockResolvedValue(false),
      initialImages: [IMAGE],
    });
    await attachTextFile('notes.txt', 'n');
    type(editor, 'retry me');
    submit(editor);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][2]).toEqual([IMAGE]);
    await waitFor(() => expect(editor.value).toBe('retry me'));
    expect(screen.getByRole('img', { name: 'Attachment 1' })).toBeInTheDocument();
    expect(screen.getByTestId('prompt-attached-file-0')).toBeInTheDocument();
  });

  test('deep agent new thread sends template id and resolved variables', async () => {
    seedTemplates([
      {
        id: 'tpl1',
        name: 'Tpl',
        variables: [
          { name: 'a', defaultValue: 'da' },
          { name: 'b', defaultValue: 'db' },
          { name: 'c' },
        ],
      } as any,
    ]);
    const { onSubmit, editor } = renderUI({
      isNewThread: true,
      unifiedModel: 'deepagent:m1',
      defaultTemplateId: 'tpl1',
    });
    fireEvent.change(screen.getByTestId('prompt-template-var-b'), { target: { value: 'typed' } });
    type(editor, 'go');
    submit(editor);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][1]).toMatchObject({
      provider: 'deepagent',
      model: 'm1',
      agentTemplateId: 'tpl1',
      templateVariables: { a: 'da', b: 'typed', c: '' },
    });
  });

  test('does nothing while loading', async () => {
    const onStopRecording = vi.fn();
    const { onSubmit } = renderUI({ loading: true, isRecording: true, onStopRecording });
    fireEvent.click(screen.getByTestId('prompt-send'));
    await new Promise((r) => setTimeout(r, 0));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onStopRecording).not.toHaveBeenCalled();
  });

  test('stops recording and warns on an empty prompt', async () => {
    const onStopRecording = vi.fn();
    const { onSubmit } = renderUI({ isRecording: true, onStopRecording });
    fireEvent.click(screen.getByTestId('prompt-send'));
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(onStopRecording).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('codex commands run locally and clear the editor', async () => {
    executeCodexCommand.mockResolvedValue(true);
    const { onSubmit, editor } = renderUI({ unifiedModel: 'codex:gpt' });
    type(editor, '/status');
    submit(editor);
    await waitFor(() => expect(executeCodexCommand).toHaveBeenCalledWith('/status'));
    await waitFor(() => expect(editor.value).toBe(''));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('unhandled codex commands fall through to onSubmit', async () => {
    executeCodexCommand.mockResolvedValue(false);
    const { onSubmit, editor } = renderUI({ unifiedModel: 'codex:gpt' });
    type(editor, '/custom');
    submit(editor);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toBe('/custom');
  });

  test('codex command failures are reported and do not submit', async () => {
    executeCodexCommand.mockRejectedValue(new Error('boom'));
    const { onSubmit, editor } = renderUI({ unifiedModel: 'codex:gpt' });
    type(editor, '/status');
    submit(editor);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('codex commands with attachments are rejected', async () => {
    const { onSubmit, editor } = renderUI({ unifiedModel: 'codex:gpt', initialImages: [IMAGE] });
    type(editor, '/status');
    submit(editor);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Send attachments in a separate message from Codex commands.',
      ),
    );
    expect(executeCodexCommand).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('provider setup lookup errors are toasted and block submit', async () => {
    vi.mocked(systemApi.providerSetupStatus).mockReturnValue(
      errAsync({ message: 'offline' }) as any,
    );
    const { onSubmit, editor } = renderUI({ projectId: 'p1' });
    type(editor, 'task');
    submit(editor);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('offline'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('bundled claude without configured auth opens provider setup', async () => {
    vi.mocked(systemApi.providerSetupStatus).mockReturnValue(
      okAsync({ provider: 'claude', state: 'bundled', auth: 'connected' }) as any,
    );
    const { onSubmit, editor } = renderUI({ projectId: 'p1' });
    type(editor, 'task');
    submit(editor);
    await screen.findByTestId('provider-setup-dialog');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('a new sandbox thread skips the project-runner provider check', async () => {
    vi.mocked(systemApi.providerSetupStatus).mockReturnValue(
      okAsync({ provider: 'claude', state: 'installed', auth: 'required' }) as any,
    );
    const onCheckoutPreflight = vi.fn(async () => false);
    const { onSubmit, editor } = renderUI({
      projectId: 'p1',
      isNewThread: true,
      runtime: 'sandbox:conn-1',
      selectedBranch: 'main',
      onCheckoutPreflight,
    });
    type(editor, 'task');
    submit(editor);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][1]).toMatchObject({
      runtime: 'sandbox',
      sandboxConnectionId: 'conn-1',
    });
    expect(systemApi.providerSetupStatus).not.toHaveBeenCalled();
    expect(onCheckoutPreflight).not.toHaveBeenCalled();
  });

  test('a follow-up on a sandbox thread skips the project-runner provider check', async () => {
    vi.mocked(systemApi.providerSetupStatus).mockReturnValue(
      okAsync({ provider: 'claude', state: 'installed', auth: 'required' }) as any,
    );
    const { onSubmit, editor } = renderUI({
      projectId: 'p1',
      powerlineThread: { id: 't1', runtime: 'sandbox' } as any,
    });
    type(editor, 'next step');
    submit(editor);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(systemApi.providerSetupStatus).not.toHaveBeenCalled();
  });

  test('skips the provider check while running or sending to backlog', async () => {
    const { onSubmit, editor } = renderUI({ projectId: 'p1', running: true });
    type(editor, 'task');
    submit(editor);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(systemApi.providerSetupStatus).not.toHaveBeenCalled();
  });
});
