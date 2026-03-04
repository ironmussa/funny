import { z } from 'zod';

import type { OpenObserveClient } from '../client.js';

export const searchToolName = 'search';

export const searchToolDescription =
  'Search OpenObserve logs or traces with a SQL query. ' +
  'Uses SQL syntax: SELECT * FROM "stream_name" WHERE match_all(\'error\'). ' +
  'Full-text search functions: match_all(text), str_match(field, text), re_match(field, pattern). ' +
  'Time range is required — specify minutes_ago for a relative window or start_time/end_time in microseconds.';

export const searchToolSchema = {
  sql: z.string().describe('SQL query, e.g. SELECT * FROM "default" WHERE match_all(\'error\')'),
  minutes_ago: z
    .number()
    .optional()
    .describe(
      'Relative time window in minutes from now (default: 15). Ignored if start_time/end_time provided.',
    ),
  start_time: z.number().optional().describe('Absolute start time in microseconds since epoch'),
  end_time: z.number().optional().describe('Absolute end time in microseconds since epoch'),
  from: z.number().optional().describe('Pagination offset (default: 0)'),
  size: z.number().optional().describe('Number of results to return (default: 100, max: 1000)'),
};

export function createSearchHandler(client: OpenObserveClient) {
  return async (args: {
    sql: string;
    minutes_ago?: number;
    start_time?: number;
    end_time?: number;
    from?: number;
    size?: number;
  }) => {
    const now = Date.now() * 1000;
    const minutesAgo = args.minutes_ago ?? 15;
    const startTime = args.start_time ?? now - minutesAgo * 60 * 1_000_000;
    const endTime = args.end_time ?? now;
    const size = Math.min(args.size ?? 100, 1000);

    const result = await client.search({
      sql: args.sql,
      startTime,
      endTime,
      from: args.from ?? 0,
      size,
    });

    const summary = `Found ${result.total} results (showing ${result.hits.length}, took ${result.took}ms, scanned ${result.scan_size}MB)`;
    const hitsText =
      result.hits.length > 0 ? JSON.stringify(result.hits, null, 2) : 'No matching records found.';

    return { content: [{ type: 'text' as const, text: `${summary}\n\n${hitsText}` }] };
  };
}
