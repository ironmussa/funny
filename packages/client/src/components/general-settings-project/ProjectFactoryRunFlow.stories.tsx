import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { ProjectFactoryRunFlow } from '@/components/general-settings-project/ProjectFactoryRunFlow';
import { buildFactoryRun } from '@/data/factory/testing';

/**
 * Which flow a factory run executed and what each agent step ran with
 * (openspec factory-flow-step-options): the source, the default-branch commit
 * (linked to the flow file there), and per step its provider, model, effort and
 * permission mode, collapsed under the run row.
 */
const meta = {
  title: 'Settings/ProjectFactoryRunFlow',
  component: ProjectFactoryRunFlow,
} satisfies Meta<typeof ProjectFactoryRunFlow>;

export default meta;
type Story = StoryObj<typeof meta>;

const step = (stepId: string, over: Record<string, unknown> = {}) => ({
  stepId,
  threadId: 'thread-1',
  provider: 'claude',
  model: 'opus',
  effort: 'high' as const,
  permissionMode: 'autoEdit',
  allowedTools: null,
  disallowedTools: null,
  thread: 'continue' as const,
  ...over,
});

export const RepositoryFlow: Story = {
  args: {
    run: buildFactoryRun({
      id: 'run-1',
      prUrl: 'https://github.com/acme/app/pull/42',
      flowName: 'issue-to-merge',
      flowSource: 'repository',
      flowCommit: 'abc1234def5678',
      stepOptions: [
        step('implement'),
        step('advise', {
          threadId: 'thread-2',
          provider: 'codex',
          model: 'gpt-5.5',
          thread: 'new',
          permissionMode: 'plan',
          effort: null,
        }),
        step('ci.before_retry', { model: 'haiku', effort: null }),
      ],
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('factory-run-flow-commit-run-1')).toHaveTextContent('abc1234');
    await userEvent.click(canvas.getByTestId('factory-run-flow-toggle-run-1'));
    await expect(canvas.getByTestId('factory-run-step-run-1-advise')).toHaveTextContent(
      'own thread',
    );
  },
};

export const BuiltInFlow: Story = {
  args: {
    run: buildFactoryRun({
      id: 'run-2',
      flowName: 'issue-to-pr',
      flowSource: 'built-in',
      stepOptions: [step('implement', { effort: null })],
    }),
  },
};
