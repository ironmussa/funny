/**
 * Messages loaded when a thread opens and on each scroll page. The server
 * caps both `messageLimit` and `limit` at 200 (`@funny/shared/contracts/threads`).
 *
 * Kept out of `lib/api/threads.ts` because tests mock that module wholesale.
 */
export const THREAD_MESSAGE_PAGE_SIZE = 200;
