#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { OpenObserveClient } from './client.js';
import { loadConfig } from './config.js';
import {
  getSchemaToolName,
  getSchemaToolDescription,
  getSchemaToolSchema,
  createGetSchemaHandler,
} from './tools/get-schema.js';
import {
  listStreamsToolName,
  listStreamsToolDescription,
  listStreamsToolSchema,
  createListStreamsHandler,
} from './tools/list-streams.js';
import {
  queryToolName,
  queryToolDescription,
  queryToolSchema,
  createQueryHandler,
} from './tools/query.js';
import {
  searchToolName,
  searchToolDescription,
  searchToolSchema,
  createSearchHandler,
} from './tools/search.js';

const config = loadConfig();
const client = new OpenObserveClient(config);

const server = new McpServer({
  name: 'openobserve',
  version: '0.1.0',
});

server.tool(searchToolName, searchToolDescription, searchToolSchema, createSearchHandler(client));
server.tool(
  listStreamsToolName,
  listStreamsToolDescription,
  listStreamsToolSchema,
  createListStreamsHandler(client),
);
server.tool(
  getSchemaToolName,
  getSchemaToolDescription,
  getSchemaToolSchema,
  createGetSchemaHandler(client),
);
server.tool(queryToolName, queryToolDescription, queryToolSchema, createQueryHandler(client));

const transport = new StdioServerTransport();
await server.connect(transport);
