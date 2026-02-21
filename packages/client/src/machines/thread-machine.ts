/**
 * Re-export the shared thread machine.
 * The canonical definition lives in @funny/shared so both client and server
 * use the same state machine.
 */
export {
  threadMachine,
  wsEventToMachineEvent,
  getResumeSystemPrefix,
  type ThreadContext,
  type ThreadEvent,
  type ResumeReason,
} from '@funny/shared/thread-machine';
