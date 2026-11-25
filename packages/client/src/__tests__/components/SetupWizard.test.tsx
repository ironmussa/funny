import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { SetupWizard } from '@/components/SetupWizard';

type CliStatus = {
  available: boolean;
  path: string | null;
  error: string | null;
  version: string | null;
};

let statuses: CliStatus[] = [];
let setupCalls = 0;

mock.module('@/lib/api', () => ({
  api: {
    bootstrap: async () => ({ isOk: () => true, value: { mode: 'standalone' } }),
    setupStatus: async () => {
      const claudeCli = statuses[Math.min(setupCalls, statuses.length - 1)];
      setupCalls += 1;
      return { isOk: () => true, value: { claudeCli } };
    },
  },
}));
mock.module('@/data/profile/actions', () => ({
  completeSetup: async () => ({ isErr: () => false }),
}));

beforeEach(() => {
  setupCalls = 0;
});
afterEach(cleanup);

async function openClaudeCheck() {
  render(<SetupWizard onComplete={() => {}} />);
  fireEvent.click(await screen.findByText('Get Started'));
}

test('checks the Claude CLI once on open and shows where it was found', async () => {
  statuses = [{ available: true, path: '/usr/bin/claude', error: null, version: '2.1.0' }];
  await openClaudeCheck();

  expect(screen.getByTestId('setup-wizard-checking')).toBeInTheDocument();
  expect(await screen.findByText('Claude CLI found')).toBeInTheDocument();
  expect(screen.getByText('2.1.0')).toBeInTheDocument();
  expect(screen.getByText('/usr/bin/claude')).toBeInTheDocument();
  expect(setupCalls).toBe(1);
});

test('a missing CLI can be checked again', async () => {
  statuses = [
    { available: false, path: null, error: 'not_found', version: null },
    { available: true, path: '/usr/bin/claude', error: null, version: null },
  ];
  await openClaudeCheck();

  expect(await screen.findByText('Claude CLI not found')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Check Again'));
  expect(await screen.findByText('Claude CLI found')).toBeInTheDocument();
  expect(setupCalls).toBe(2);
});
