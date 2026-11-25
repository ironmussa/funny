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
// SAFETY: callers pass c.get('userId') set by the session middleware, or the owner
// id a system caller (automation, factory, public API) read from the DB.
export const authenticatedUserId = (value: string): UserId => value as UserId;

/** Wrap a runner id returned by user-scoped runner resolution. */
// SAFETY: called only in runner-for.ts after certify() / the OAuth state check
// verified the runner's owner, and on the id that prover handed to its callback.
export const resolvedRunnerId = (value: string): RunnerId => value as RunnerId;

/** Wrap a thread id returned by the runner that created the thread. */
// SAFETY: called only on the id read from the runner's create / fork response,
// on the runner that user-scoped resolution picked for the actor.
export const createdThreadId = (value: string): ThreadId => value as ThreadId;

/** Wrap the id of a thread the access middleware loaded and authorized for the actor. */
// SAFETY: called only on the id of the source row requireThreadOwner loaded and
// authorized for the fork route.
export const authorizedThreadId = (value: string): ThreadId => value as ThreadId;
