// ---------------------------------------------------------------------------
// MCP endpoint — Streamable HTTP transport, mounted at /mcp.
//
// External AI agents (e.g. the Claude MCP connector) authenticate with a
// bearer token in the Authorization header:
//
//     Authorization: Bearer solytiq_pat_xxxxxxxx
//
// Tokens are minted by the OAuth flow (routes/oauth.ts) when the user connects
// Claude from Settings. On a missing/invalid token the 401 advertises the
// Protected Resource Metadata document (RFC 9728) so the connector can
// discover the authorization server and run the OAuth handshake automatically.
//
// The verified userId is injected into every tool call by buildMcpServer, so
// no user identity ever travels through tool arguments. The transport runs in
// stateless mode (a new server + transport per request), which is simple and
// robust behind a load balancer / Nginx.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from '../mcpServer';
import { authenticateApiToken } from '../apiToken';
import { getPublicBaseUrl } from '../publicUrl';

const router = Router();

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0' as const, error: { code, message }, id: null };
}

// Point unauthenticated clients at the resource metadata so they can begin OAuth.
function setWwwAuthenticate(req: Request, res: Response): void {
  const resourceMetadata = `${getPublicBaseUrl(req)}/.well-known/oauth-protected-resource`;
  res.setHeader(
    'WWW-Authenticate',
    `Bearer realm="Solytiq MCP", error="invalid_token", resource_metadata="${resourceMetadata}"`
  );
}

// Bearer-token authentication for the MCP endpoint.
async function authMcp(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    setWwwAuthenticate(req, res);
    res.status(401).json(jsonRpcError(-32001, 'Authentication required. Connect Claude from Solytiq settings.'));
    return;
  }
  const auth = await authenticateApiToken(header.slice(7));
  if (!auth) {
    setWwwAuthenticate(req, res);
    res.status(401).json(jsonRpcError(-32001, 'Invalid or expired access token.'));
    return;
  }
  (req as Request & { mcpUserId: string }).mcpUserId = auth.userId;
  next();
}

// POST /mcp — handle a JSON-RPC MCP request (initialize, tools/list, tools/call …)
router.post('/', authMcp, async (req: Request, res: Response) => {
  const userId = (req as Request & { mcpUserId: string }).mcpUserId;
  const server = buildMcpServer(userId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request error:', err);
    if (!res.headersSent) {
      res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
    }
  }
});

// Stateless mode does not support server-initiated streams or session teardown.
router.get('/', (_req: Request, res: Response) => {
  res.status(405).json(jsonRpcError(-32000, 'Method not allowed. This MCP server is stateless; use POST.'));
});
router.delete('/', (_req: Request, res: Response) => {
  res.status(405).json(jsonRpcError(-32000, 'Method not allowed.'));
});

export default router;
