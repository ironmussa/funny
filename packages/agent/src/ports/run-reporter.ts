/**
 * Where a factory run's events go.
 *
 * Events have the fields of funny's ingest events, so connecting the factory
 * to funny later is a new adapter, not a new format.
 */

export interface RunEvent {
  event_type: string;
  /** The run id. */
  request_id: string;
  /** The run id: one factory run is one thread once it reports into funny. */
  thread_id: string;
  /** ISO 8601. */
  timestamp: string;
  data: Record<string, unknown>;
}

export interface RunReporter {
  report(event: RunEvent): Promise<void>;
}
