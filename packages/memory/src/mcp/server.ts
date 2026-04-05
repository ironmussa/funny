/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain subdomain-type: core
 * @domain type: infrastructure-service
 * @domain layer: infrastructure
 *
 * MCP Server for Paisley Park.
 * Exposes memory operations as MCP tools so any MCP-aware agent
 * (Claude Code, Cursor, etc.) can interact with project memory.
 *
 * Runs as a stdio transport MCP server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { getPaisleyPark } from '../index.js';

const PROJECT_ID = process.env.PP_PROJECT_ID ?? 'default';
const PROJECT_NAME = process.env.PP_PROJECT_NAME ?? 'default';
const DB_URL = process.env.PP_DB_URL ?? 'file:memory.db';
const SYNC_URL = process.env.PP_SYNC_URL;
const AUTH_TOKEN = process.env.PP_AUTH_TOKEN;

const server = new McpServer({
  name: 'paisley-park',
  version: '1.0.0',
});

// ─── pp_recall ─────────────────────────────────────────

server.tool(
  'pp_recall',
  'Retrieve relevant project memories for the current context',
  {
    query: z.string().describe('What to search for in project memory'),
    limit: z.number().optional().describe('Max facts to return (default 10)'),
    scope: z.enum(['project', 'operator', 'team', 'all']).optional().describe('Memory scope'),
  },
  async ({ query, limit, scope }) => {
    const pp = getPaisleyPark({
      url: DB_URL,
      syncUrl: SYNC_URL,
      authToken: AUTH_TOKEN,
      projectId: PROJECT_ID,
      projectName: PROJECT_NAME,
    });
    const result = await pp.recall(query, { limit, scope });

    return {
      content: [
        {
          type: 'text' as const,
          text: result.formattedContext || 'No relevant memories found.',
        },
      ],
    };
  },
);

// ─── pp_add ────────────────────────────────────────────

server.tool(
  'pp_add',
  'Add new knowledge to project memory',
  {
    content: z.string().describe('The fact to remember'),
    type: z
      .enum(['decision', 'bug', 'pattern', 'convention', 'insight', 'context'])
      .describe('Type of knowledge'),
    tags: z.array(z.string()).optional().describe('Tags for categorization'),
  },
  async ({ content, type, tags }) => {
    const pp = getPaisleyPark({
      url: DB_URL,
      syncUrl: SYNC_URL,
      authToken: AUTH_TOKEN,
      projectId: PROJECT_ID,
      projectName: PROJECT_NAME,
    });
    const fact = await pp.add(content, { type, tags });

    return {
      content: [
        {
          type: 'text' as const,
          text: `Fact added: ${fact.id} (type: ${type})`,
        },
      ],
    };
  },
);

// ─── pp_invalidate ─────────────────────────────────────

server.tool(
  'pp_invalidate',
  'Mark a piece of knowledge as no longer valid',
  {
    factId: z.string().describe('ID of the fact to invalidate'),
    reason: z.string().optional().describe('Why this is no longer valid'),
  },
  async ({ factId, reason }) => {
    const pp = getPaisleyPark({
      url: DB_URL,
      syncUrl: SYNC_URL,
      authToken: AUTH_TOKEN,
      projectId: PROJECT_ID,
      projectName: PROJECT_NAME,
    });
    await pp.invalidate(factId, reason);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Fact ${factId} invalidated${reason ? `: ${reason}` : ''}`,
        },
      ],
    };
  },
);

// ─── pp_search ─────────────────────────────────────────

server.tool(
  'pp_search',
  'Search project memories with filters',
  {
    query: z.string().describe('Search query'),
    type: z.enum(['decision', 'bug', 'pattern', 'convention', 'insight', 'context']).optional(),
    tags: z.array(z.string()).optional(),
    validAt: z.string().optional().describe('ISO date — only facts valid at this time'),
  },
  async ({ query, type, tags, validAt }) => {
    const pp = getPaisleyPark({
      url: DB_URL,
      syncUrl: SYNC_URL,
      authToken: AUTH_TOKEN,
      projectId: PROJECT_ID,
      projectName: PROJECT_NAME,
    });
    const facts = await pp.search(query, { type, tags, validAt });

    if (facts.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No facts found.' }] };
    }

    const formatted = facts
      .map((f) => {
        const tagStr = f.tags.length > 0 ? ` [${f.tags.join(', ')}]` : '';
        return `- **${f.id}** (${f.type})${tagStr}: ${f.content.split('\n')[0].slice(0, 150)}`;
      })
      .join('\n');

    return { content: [{ type: 'text' as const, text: formatted }] };
  },
);

// ─── Start server ──────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
