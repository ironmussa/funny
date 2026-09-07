import { CODEX_COMMANDS, parseCodexCommand } from '@funny/shared/codex-commands';
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import type { ModelSelectGroup } from '@/components/PromptInputUI';
import { threadsApi } from '@/lib/api/threads';
import { getEffortLevels } from '@/lib/providers';
import { canDoGitOps, isScratch, getThreadRoute } from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

interface Options {
  threadId?: string;
  model: string;
  mode: string;
  effort?: string;
  running: boolean;
  modelGroups: ModelSelectGroup[];
  modes: { value: string; label: string }[];
  onModelChange: (value: string) => void;
  onModeChange: (value: string) => void;
  onEffortChange?: (value: string) => void;
  onStop?: () => void;
  onOpenReview?: () => void;
}

/** Returns true for composer actions; native commands continue to the provider. */
export function useCodexCommands(options: Options) {
  const navigate = useNavigate();
  return useCallback(
    async (text: string): Promise<boolean> => {
      const command = parseCodexCommand(text);
      if (!command) return false;
      const { name, args } = command;
      const ui = useUIStore.getState();
      const thread = options.threadId
        ? useThreadStore.getState().threadsById[options.threadId]
        : undefined;
      const requireThread = () => {
        if (!options.threadId) throw new Error('Open a conversation first.');
        return options.threadId;
      };
      const noArgs = () => {
        if (args) throw new Error(`/${name} does not accept arguments.`);
      };
      switch (name) {
        case 'help':
          noArgs();
          toast.info('Codex commands', {
            description: Object.entries(CODEX_COMMANDS)
              .map(([key, description]) => `/${key} — ${description}`)
              .join('\n'),
            duration: 20_000,
          });
          return true;
        case 'model': {
          const models = options.modelGroups
            .filter((group) => group.provider === 'codex' && !group.disabled)
            .flatMap((group) => group.models.filter((model) => !model.disabled));
          if (!args)
            toast.info(`Current model: ${options.model}`, {
              description: models.map((model) => model.value.replace(/^codex:/, '')).join(', '),
            });
          else {
            const selected = models.find(
              (model) => model.value === args || model.value === `codex:${args}`,
            );
            if (!selected)
              throw new Error('Unknown or unavailable model. Use /model to list models.');
            options.onModelChange(selected.value);
          }
          return true;
        }
        case 'reasoning': {
          const levels = getEffortLevels(options.model, 'codex');
          if (!args)
            toast.info(`Reasoning: ${options.effort ?? 'default'}`, {
              description: levels.map((level) => level.value).join(', '),
            });
          else {
            if (!options.onEffortChange || !levels.some((level) => level.value === args))
              throw new Error('Unavailable reasoning effort. Use /reasoning to list levels.');
            options.onEffortChange(args);
          }
          return true;
        }
        case 'permissions':
          if (!args)
            toast.info(`Permissions: ${options.mode}`, {
              description: options.modes.map((mode) => `${mode.value}: ${mode.label}`).join(', '),
            });
          else {
            if (!options.modes.some((mode) => mode.value === args))
              throw new Error('Unknown permission mode. Use /permissions to list modes.');
            options.onModeChange(args);
          }
          return true;
        case 'plan': {
          noArgs();
          const next =
            options.mode === 'plan'
              ? options.modes.find((mode) => mode.value !== 'plan')?.value
              : 'plan';
          if (!next || !options.modes.some((mode) => mode.value === next))
            throw new Error('Plan mode is unavailable.');
          options.onModeChange(next);
          return true;
        }
        case 'stop':
          noArgs();
          if (!options.running || !options.onStop) throw new Error('No running turn to stop.');
          options.onStop();
          return true;
        case 'diff':
          noArgs();
          if (!options.onOpenReview)
            throw new Error('Open a project conversation to view its diff.');
          options.onOpenReview();
          return true;
        case 'new':
        case 'clear': {
          noArgs();
          const projectId =
            thread?.projectId ??
            ui.newThreadProjectId ??
            useProjectStore.getState().selectedProjectId;
          if (isScratch(thread) || ui.newThreadIsScratch || !projectId) {
            ui.startNewScratchThread();
            navigate(buildPath('/'));
          } else {
            ui.startNewThread(projectId);
            navigate(buildPath(`/projects/${projectId}`));
          }
          return true;
        }
        case 'resume':
          noArgs();
          ui.showGlobalSearch();
          return true;
        case 'rename': {
          const id = requireThread();
          if (!args) throw new Error('Usage: /rename title');
          const result = await threadsApi.renameThread(id, args);
          if (result.isErr()) throw new Error(result.error.message);
          await useThreadStore.getState().loadThreadsForProject(result.value.projectId);
          return true;
        }
        case 'archive': {
          noArgs();
          const id = requireThread();
          if (options.running) throw new Error('Stop the running turn before archiving.');
          const result = await threadsApi.archiveThread(id, true);
          if (result.isErr()) throw new Error(result.error.message);
          if (thread?.projectId)
            await useThreadStore.getState().loadThreadsForProject(thread.projectId);
          ui.showGlobalSearch();
          return true;
        }
        case 'copy':
        case 'fork': {
          noArgs();
          const id = requireThread();
          if (name === 'fork' && options.running)
            throw new Error('Wait for the running turn before forking.');
          const result = await threadsApi.getThread(id);
          if (result.isErr()) throw new Error(result.error.message);
          const source = result.value;
          if (name === 'copy') {
            const message = source.messages.findLast(
              (message) => message.role === 'assistant' && message.content.trim(),
            );
            if (!message) throw new Error('No assistant response to copy.');
            await navigator.clipboard.writeText(message.content);
            toast.success('Response copied');
          } else {
            if (!canDoGitOps(source)) throw new Error('Fork requires a project conversation.');
            const message = source.messages.at(-1);
            if (!message) throw new Error('Send a message before forking.');
            const fork = await threadsApi.forkThread(id, message.id);
            if (fork.isErr()) throw new Error(fork.error.message);
            await useThreadStore.getState().loadThreadsForProject(source.projectId);
            useThreadStore.setState({ selectedThreadId: fork.value.id });
            navigate(buildPath(getThreadRoute(fork.value)));
          }
          return true;
        }
        default:
          return false;
      }
    },
    [navigate, options],
  );
}
