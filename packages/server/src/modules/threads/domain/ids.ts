/**
 * Local branded identifiers for the threads module.
 *
 * Brands stop a user id from being passed where a runner or thread id is
 * expected. They are minted ONLY at trusted boundaries (the authenticated
 * session, runner resolution, the runner's creation response). A brand records
 * where a value came from. It does not prove authorization and is not wire
 * validation, and the shared `Thread` DTO keeps plain strings.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Brand<string, 'UserId'>;
export type RunnerId = Brand<string, 'RunnerId'>;
export type ThreadId = Brand<string, 'ThreadId'>;

/** Wrap the user id taken from the authenticated session. */
export const authenticatedUserId = (value: string): UserId => value as UserId;

/** Wrap a runner id returned by user-scoped runner resolution. */
export const resolvedRunnerId = (value: string): RunnerId => value as RunnerId;

/** Wrap a thread id returned by the runner that created the thread. */
export const createdThreadId = (value: string): ThreadId => value as ThreadId;
