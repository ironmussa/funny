/**
 * Re-export the shared thread machine.
 * The canonical definition lives in @funny/shared so both client and server
 * use the same state machine.
 */
export { threadMachine, wsEventToMachineEvent } from '@funny/shared/thread-machine';
