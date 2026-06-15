// ---------------------------------------------------------------------------
// MCP server factory.
//
// Builds a Model Context Protocol server whose tools are the shared registry
// (aiTools.ts). A fresh server is created per authenticated request (stateless
// HTTP transport), bound to the verified userId so every tool call is scoped to
// that user — the agent can never address another user's data.
// ---------------------------------------------------------------------------

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getMcpToolDefs, executeAiTool } from './aiTools';

export function buildMcpServer(userId: string): Server {
  const server = new Server(
    { name: 'solytiq-cloud', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getMcpToolDefs(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const r = await executeAiTool(userId, name, (args ?? {}) as Record<string, unknown>);
    return {
      content: [{ type: 'text', text: r.result }],
      isError: !r.ok,
    };
  });

  return server;
}
