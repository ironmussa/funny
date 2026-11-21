import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { ProjectSecretsSetting } from '@/components/general-settings-project/ProjectSecretsSetting';
import { buildProjectSecret, seedProjectSecrets } from '@/data/project-secrets/testing';

/**
 * A project's secrets in its settings (openspec project-secrets): the shared
 * list and the caller's own. The lists are seeded, so nothing is requested; a
 * value never appears, only names and settings.
 */
const meta = {
  title: 'Settings/ProjectSecretsSetting',
  component: ProjectSecretsSetting,
  args: { projectId: 'project-1' },
  decorators: [(Story) => <div className="max-w-2xl p-4">{Story()}</div>],
} satisfies Meta<typeof ProjectSecretsSetting>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  render: (args) => {
    seedProjectSecrets(args.projectId, []);
    return <ProjectSecretsSetting {...args} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('settings-secrets-empty-project')).toBeInTheDocument();
    await expect(canvas.getByTestId('settings-secrets-empty-user')).toBeInTheDocument();
  },
};

export const SharedAndPersonal: Story = {
  render: (args) => {
    seedProjectSecrets(args.projectId, [
      buildProjectSecret({ id: 's1', name: 'DATABASE_URL', allowInSandbox: true }),
      buildProjectSecret({ id: 's2', name: 'STRIPE_KEY' }),
      buildProjectSecret({ id: 's3', name: 'DATABASE_URL', scope: 'user' }),
    ]);
    return <ProjectSecretsSetting {...args} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByTestId('settings-secret-override-project-DATABASE_URL'),
    ).toBeInTheDocument();
    await expect(
      canvas.getByTestId('settings-secret-override-user-DATABASE_URL'),
    ).toBeInTheDocument();
  },
};

export const ReplaceDialog: Story = {
  render: (args) => {
    seedProjectSecrets(args.projectId, [buildProjectSecret({ id: 's1', name: 'STRIPE_KEY' })]);
    return <ProjectSecretsSetting {...args} />;
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId('settings-secret-replace-project-STRIPE_KEY'));
    const body = within(document.body);
    await expect(await body.findByTestId('settings-secret-value')).toHaveValue('');
    await expect(body.getByTestId('settings-secret-name')).toHaveAttribute('readonly');
  },
};
