import { z } from 'zod';

import type { OpenObserveClient } from '../client.js';

export const getSchemaToolName = 'get_schema';

export const getSchemaToolDescription =
  'Get the schema (field names and types) for a specific OpenObserve stream. ' +
  'Use this to discover what fields are available before writing SQL queries.';

export const getSchemaToolSchema = {
  stream: z.string().describe('Name of the stream to get schema for'),
  type: z.enum(['logs', 'metrics', 'traces']).optional().describe('Stream type (default: logs)'),
};

export function createGetSchemaHandler(client: OpenObserveClient) {
  return async (args: { stream: string; type?: string }) => {
    const result = await client.getSchema(args.stream, args.type ?? 'logs');

    const output = {
      name: result.name,
      type: result.stream_type,
      records: result.stats.doc_num,
      fields: result.schema.map((f) => ({ name: f.name, type: f.type })),
      full_text_search_keys: result.settings?.full_text_search_keys ?? [],
    };

    return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }] };
  };
}
