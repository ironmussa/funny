/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain aggregate: Thread
 * @domain depends: Database
 *
 * DB-agnostic message repository. Accepts db + schema via dependency injection.
 * The queries live in `./message-repository/`; this factory binds them to `deps`.
 */

import type { RepoDeps } from './deps.js';
import { enrichMessages } from './message-repository/rows.js';
import { searchMessages } from './message-repository/search.js';
import { getThreadMessages } from './message-repository/thread-messages.js';
import { getThreadWithMessages } from './message-repository/thread-with-messages.js';
import { deleteMessagesAfter, insertMessage, updateMessage } from './message-repository/writes.js';

export type MessageRepositoryDeps = RepoDeps;

/** A query's parameters after `deps`, with their names and optionality. */
type QueryArgs<F> = F extends (deps: RepoDeps, ...args: infer A) => infer _R ? A : never;

export function createMessageRepository(deps: MessageRepositoryDeps) {
  return {
    /** Enrich raw message rows with parsed images and their tool calls */
    enrichMessages: (...args: QueryArgs<typeof enrichMessages>) => enrichMessages(deps, ...args),
    getThreadWithMessages: (...args: QueryArgs<typeof getThreadWithMessages>) =>
      getThreadWithMessages(deps, ...args),
    getThreadMessages: (...args: QueryArgs<typeof getThreadMessages>) =>
      getThreadMessages(deps, ...args),
    searchMessages: (...args: QueryArgs<typeof searchMessages>) => searchMessages(deps, ...args),
    insertMessage: (...args: QueryArgs<typeof insertMessage>) => insertMessage(deps, ...args),
    updateMessage: (...args: QueryArgs<typeof updateMessage>) => updateMessage(deps, ...args),
    deleteMessagesAfter: (...args: QueryArgs<typeof deleteMessagesAfter>) =>
      deleteMessagesAfter(deps, ...args),
  };
}
