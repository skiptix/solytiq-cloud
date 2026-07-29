// ---------------------------------------------------------------------------
// MCP server factory.
//
// Builds a Model Context Protocol server whose tools are the shared registry
// (aiTools.ts). A fresh server is created per authenticated request (stateless
// HTTP transport), bound to the verified userId so every tool call is scoped to
// that user — the agent can never address another user's data.
//
// serverInfo carries a title, website and icon so MCP clients (e.g. Claude)
// render the Solytiq branding on the connector instead of a generic globe.
//
// Resources + Prompts (WP-8): resources (mcpResources.ts) expose read-only
// solytiq://... URIs into the same data the tools touch, scoped through the
// identical Graph Layer visibility boundary; prompts (mcpPrompts.ts) are pure
// message templates, no server-side execution. resources/subscribe is
// accepted (per-spec) but never actually notifies — this transport is
// stateless (a new server+transport per HTTP request, see routes/mcp.ts), so
// there is no live connection left to push a notifications/resources/updated
// message through after the request completes. A known, accepted limitation
// rather than a subscription that silently never fires.
// ---------------------------------------------------------------------------

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
  ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema,
  SubscribeRequestSchema, UnsubscribeRequestSchema,
  ListPromptsRequestSchema, GetPromptRequestSchema,
  McpError, ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { getMcpToolDefs, executeAiTool } from './aiTools';
import { MCP_STATIC_RESOURCES, MCP_RESOURCE_TEMPLATES, readMcpResource } from './mcpResources';
import { MCP_PROMPTS, buildPromptMessages } from './mcpPrompts';

export function buildMcpServer(userId: string, baseUrl: string): Server {
  const server = new Server(
    {
      name: 'solytiq-cloud',
      title: 'Solytiq Cloud',
      version: '1.17.0',
      websiteUrl: baseUrl,
      icons: [
        { src: `${baseUrl}/solytiq-cloud.png`, mimeType: 'image/png', sizes: ['512x512'] },
      ],
    },
    { capabilities: { tools: {}, resources: { subscribe: true }, prompts: {} } }
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

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: MCP_STATIC_RESOURCES,
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: MCP_RESOURCE_TEMPLATES,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const content = await readMcpResource(userId, req.params.uri);
    if (!content) throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${req.params.uri}`);
    return { contents: [{ uri: req.params.uri, mimeType: content.mimeType, text: content.text }] };
  });

  // Accepted per-spec; never fires (see file header — the stateless transport
  // has no connection left to push a live update through).
  server.setRequestHandler(SubscribeRequestSchema, async () => ({}));
  server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: MCP_PROMPTS,
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const promptDef = MCP_PROMPTS.find((p) => p.name === req.params.name);
    if (!promptDef) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${req.params.name}`);
    const messages = buildPromptMessages(req.params.name, (req.params.arguments ?? {}) as Record<string, string>);
    if (!messages) throw new McpError(ErrorCode.InvalidParams, 'Missing a required argument for this prompt');
    return { description: promptDef.description, messages };
  });

  return server;
}
