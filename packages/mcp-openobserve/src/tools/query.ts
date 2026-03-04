import { z } from 'zod';

import type { OpenObserveClient } from '../client.js';

export const queryToolName = 'query';

export const queryToolDescription =
  'Run an arbitrary SQL query against OpenObserve with full aggregation support. ' +
  "Use for: COUNT, AVG, SUM, MIN, MAX with GROUP BY; histogram(_timestamp, '5 minute'); " +
  'and complex analytical queries. Always include a time range.';

export const queryToolSchema = {
  sql: z
    .string()
    .describe(
      'SQL query with aggregations, e.g. SELECT histogram(_timestamp, \'5 minute\') as ts, count(*) as total FROM "default" GROUP BY ts',
    ),
  minutes_ago: z
    .number()
    .optional()
    .describe(
      'Relative time window in minutes from now (default: 60). Ignored if start_time/end_time provided.',
    ),
  start_time: z.number().optional().describe('Absolute start time in microseconds'),
  end_time: z.number().optional().describe('Absolute end time in microseconds'),
};

export function createQueryHandler(client: OpenObserveClient) {
  return async (args: {
    sql: string;
    minutes_ago?: number;
    start_time?: number;
    end_time?: number;
  }) => {
    const now = Date.now() * 1000;
    const minutesAgo = args.minutes_ago ?? 60;
    const startTime = args.start_time ?? now - minutesAgo * 60 * 1_000_000;
    const endTime = args.end_time ?? now;

    const result = await client.search({
      sql: args.sql,
      startTime,
      endTime,
      from: 0,
      size: 0,
    });

    const summary = `Query returned ${result.total} matching records (took ${result.took}ms, scanned ${result.scan_size}MB)`;
    const data =
      result.hits.length > 0
        ? JSON.stringify(result.hits, null, 2)
        : 'No results. Check your SQL syntax and time range.';

    return { content: [{ type: 'text' as const, text: `${summary}\n\n${data}` }] };
  };
}
