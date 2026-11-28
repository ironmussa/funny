import { setup } from 'xstate';

import { statusWriteGuards } from './status-transitions.js';

export const FACTORY_FLOW_SETUP_STATES = [
  'generating',
  'verifying',
  'proposed',
  'committing',
  'push_rejected',
  'pr_open',
  'committed',
  'discarded',
  'failed',
] as const;

export type FactoryFlowSetupState = (typeof FACTORY_FLOW_SETUP_STATES)[number];

/** States where a setup is still open (enforced by the partial unique index). */
export const FACTORY_FLOW_SETUP_OPEN_STATES: readonly FactoryFlowSetupState[] = [
  'generating',
  'verifying',
  'proposed',
  'committing',
  'push_rejected',
  'pr_open',
] as const;

/** States where a setup has ended (a member may start a new setup for the same flow). */
export const FACTORY_FLOW_SETUP_ENDED_STATES: readonly FactoryFlowSetupState[] = [
  'committed',
  'discarded',
  'failed',
] as const;

export function isEndedFactoryFlowSetupState(state: FactoryFlowSetupState): boolean {
  return state === 'committed' || state === 'discarded' || state === 'failed';
}

interface FactoryFlowSetupMachineTypes {
  events: {
    type:
      | 'THREAD_COMPLETED'
      | 'FAIL'
      | 'PROPOSE'
      | 'CONFIRM'
      | 'CONFIRM_OPT_OUT'
      | 'PUSHED'
      | 'PUSH_REJECTED'
      | 'RETRY_PROPOSAL'
      | 'RETRY_FAILED'
      | 'OPEN_PR'
      | 'COMMITTED'
      | 'DISCARD';
  };
}

/**
 * Factory flow setup lifecycle (openspec `factory-flow-bootstrap`, D4).
 * Enforced by `factory-flow-setup-repository.ts` via compare-and-set on every
 * state write.
 *
 *   generating ──THREAD_COMPLETED──▶ verifying ──PROPOSE──▶ proposed
 *   generating | verifying ──FAIL──▶ failed
 *   proposed ──CONFIRM──▶ committing
 *   failed ──CONFIRM_OPT_OUT──▶ committing        (opt-out commit from failed)
 *   committing ──PUSHED──▶ committed
 *   committing ──PUSH_REJECTED──▶ push_rejected
 *   committing ──RETRY_PROPOSAL──▶ proposed       (runner unreachable, file not on branch)
 *   committing ──RETRY_FAILED──▶ failed           (runner unreachable during opt-out)
 *   push_rejected ──OPEN_PR──▶ pr_open
 *   proposed | push_rejected | pr_open ──DISCARD──▶ discarded
 *   pr_open ──COMMITTED──▶ committed              (file landed on default branch)
 *
 * `committed` and `discarded` are final. `failed` ends the setup for the
 * one-open-setup rule, while still allowing an explicit opt-out commit.
 */
export const factoryFlowSetupMachine = setup({
  // SAFETY: xstate's `types` is a type-only carrier; the empty object is never read at runtime.
  types: {} as FactoryFlowSetupMachineTypes,
}).createMachine({
  id: 'factoryFlowSetup',
  initial: 'generating',
  states: {
    generating: {
      on: {
        THREAD_COMPLETED: 'verifying',
        FAIL: 'failed',
      },
    },
    verifying: {
      on: {
        PROPOSE: 'proposed',
        FAIL: 'failed',
      },
    },
    proposed: {
      on: {
        CONFIRM: 'committing',
        DISCARD: 'discarded',
      },
    },
    failed: {
      on: {
        CONFIRM_OPT_OUT: 'committing',
      },
    },
    committing: {
      on: {
        PUSHED: 'committed',
        PUSH_REJECTED: 'push_rejected',
        RETRY_PROPOSAL: 'proposed',
        RETRY_FAILED: 'failed',
      },
    },
    push_rejected: {
      on: {
        OPEN_PR: 'pr_open',
        DISCARD: 'discarded',
      },
    },
    pr_open: {
      on: {
        COMMITTED: 'committed',
        DISCARD: 'discarded',
      },
    },
    committed: { type: 'final' },
    discarded: { type: 'final' },
  },
});

/** The states each factory flow setup state may be written from. */
export const FACTORY_FLOW_SETUP_WRITTEN_FROM =
  statusWriteGuards<FactoryFlowSetupState>(factoryFlowSetupMachine);
