import { z } from 'zod';

import type { OpenObserveClient } from '../client.js';

export const listStreamsToolName = 'list_streams';

export const listStreamsToolDescription =
  'List available OpenObserve streams. Streams are like tables that contain logs, metrics, or traces data.';

export const listStreamsToolSchema = {
  type: z
    .enum(['logs', 'metrics', 'traces'])
    .optional()
    .describe('Stream type to list (default: logs)'),
  fetch_schema: z
    .boolean()
    .optional()
    .describe('Include field schema for each stream (default: false)'),
};

export function createListStreamsHandler(client: OpenObserveClient) {
  return async (args: { type?: string; fetch_schema?: boolean }) => {
    const result = await client.listStreams(args.type ?? 'logs', args.fetch_schema ?? false);

    const streams = result.list.map((s) => {
      const info: Record<string, unknown> = {
        name: s.name,
        type: s.stream_type,
        records: s.stats.doc_num,
        storage_mb: Math.round(s.stats.storage_size * 100) / 100,
        compressed_mb: Math.round(s.stats.compressed_size * 100) / 100,
      };
      if (s.schema) {
        info.fields = s.schema.map((f) => `${f.name} (${f.type})`);
      }
      return info;
    });

    return { content: [{ type: 'text' as const, text: JSON.stringify(streams, null, 2) }] };
  };
}
