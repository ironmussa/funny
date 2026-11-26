/**
 * The shape of a runner → server data message executor, shared by
 * `data-message-handlers.ts` and its sibling handler modules.
 */

export interface DataMessageContext {
  runnerId: string;
  /** DB-recorded owner of the runner (already validated by the ownership guard). */
  runnerUserId: string | null;
  /**
   * The user every user-scoped handler acts as: the runner's owner, NEVER a
   * payload-supplied userId. The ownership guard refuses every non-neutral
   * request from a runner without an owner, so this is only '' for the
   * user-neutral types (a missing data.userId used to widen list_projects to
   * every tenant — audit C4).
   */
  ownerId: string;
  data: any;
}

export type DataMessageHandler = (ctx: DataMessageContext) => Promise<any>;

/** `data:*` message type → the executor that answers it. */
export interface DataMessageHandlers {
  readonly [type: string]: DataMessageHandler;
}
