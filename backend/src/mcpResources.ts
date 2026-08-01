// ---------------------------------------------------------------------------
// MCP resources — read-only, URI-addressable views into a user's data,
// exposed alongside the tool registry (aiTools.ts) to MCP clients. Every read
// goes through the SAME visibility boundary as the rest of the Graph Layer
// (graph/visibility.ts) — an inaccessible entity/workspace 404s from a
// resource read exactly like it would from any other Graph Layer read.
//
// Two static resources (fixed URI, always listed) plus three URI TEMPLATES
// (a class of resources, e.g. one per entity — discovered via
// resources/templates/list, read via resources/read once a client fills in
// the template). See mcpServer.ts for how these wire into the MCP SDK.
// ---------------------------------------------------------------------------

import { query } from './db';
import { userCanAccessWorkspace } from './workspaceUtil';
import { visibleCondition } from './graph/visibility';
import { getEntityIndexEntry } from './graph/entityIndex';
import { isValidEntityType } from './graph/srn';
import { getQueueStats } from './knowledge/queue';
import { isPgvectorAvailable } from './knowledge/state';
import { getEmbeddingConfig } from './knowledge/embedProvider';
import { listGlossary, lookupTerm } from './knowledgeBase/lookup';

export interface McpResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export const MCP_STATIC_RESOURCES: McpResourceDef[] = [
  { uri: 'solytiq://workspaces', name: 'Workspaces', description: "The authenticated user's accessible workspaces", mimeType: 'application/json' },
  { uri: 'solytiq://knowledge/status', name: 'Knowledge Layer status', description: 'Semantic search availability, provider config, and indexing queue depth', mimeType: 'application/json' },
];

export interface McpResourceTemplateDef {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

export const MCP_RESOURCE_TEMPLATES: McpResourceTemplateDef[] = [
  { uriTemplate: 'solytiq://entity/{type}/{id}', name: 'Entity', description: 'Full entity_index detail for one linkable item (task, list, markdownList, timeline, milestone, meeting, folder, file, section, gpsFile)', mimeType: 'application/json' },
  { uriTemplate: 'solytiq://graph/{workspaceId}', name: 'Workspace graph', description: 'Nodes + edges for one workspace, capped at 200 nodes for a resource read (use the graph tools/API for the full explorer)', mimeType: 'application/json' },
  { uriTemplate: 'solytiq://agent/{workspaceId}/runs', name: 'Agent runs', description: 'The 20 most recent AI agent runs for one workspace', mimeType: 'application/json' },
  // The dictionary, as a RESOURCE rather than only a tool: a client can pull
  // the whole glossary into context once instead of tool-calling per term,
  // which is what makes an agent aware of a workspace's vocabulary before it
  // starts guessing at it.
  { uriTemplate: 'solytiq://knowledge/{workspaceId}/glossary', name: 'Knowledge Base glossary', description: "Every term defined in one workspace's Knowledge Base, with aliases and one-line summaries (no bodies — small enough to carry as context)", mimeType: 'application/json' },
  { uriTemplate: 'solytiq://knowledge/{workspaceId}/term/{term}', name: 'Knowledge Base term', description: 'The full definition of one term (or an explicit not-defined result with near-miss suggestions)', mimeType: 'application/json' },
];

const GRAPH_RESOURCE_NODE_CAP = 200;

export interface McpResourceContent {
  text: string;
  mimeType: string;
}

/** Read one resource by its exact URI (static or template-instantiated). Returns null for an unrecognized/inaccessible URI — the caller 404s, never leaking which is true. */
export async function readMcpResource(userId: string, uri: string): Promise<McpResourceContent | null> {
  if (uri === 'solytiq://workspaces') {
    const r = await query<{ id: string; name: string; visibility: string; owner_id: string; agent_mode: string }>(
      `SELECT w.id, w.name, w.visibility, w.owner_id, w.agent_mode FROM workspaces w
       LEFT JOIN workspace_members wm ON w.id = wm.workspace_id AND wm.user_id = $1
       WHERE wm.user_id = $1 OR w.owner_id = $1 OR w.visibility = 'public'
       ORDER BY w.name ASC`,
      [userId]
    );
    return { mimeType: 'application/json', text: JSON.stringify(r.rows.map((w) => ({ id: w.id, name: w.name, visibility: w.visibility, isOwner: w.owner_id === userId, agentMode: w.agent_mode })), null, 2) };
  }

  if (uri === 'solytiq://knowledge/status') {
    const settingsRes = await query<{ key: string; value: string }>(`SELECT key, value FROM app_settings`);
    const settings: Record<string, string> = {};
    for (const row of settingsRes.rows) settings[row.key] = row.value;
    const stats = await getQueueStats();
    return {
      mimeType: 'application/json',
      text: JSON.stringify({
        pgvectorAvailable: isPgvectorAvailable(),
        providerConfigured: getEmbeddingConfig(settings) !== null,
        searchEnabled: settings.knowledge_search_enabled !== 'false',
        queue: stats,
      }, null, 2),
    };
  }

  let m = uri.match(/^solytiq:\/\/entity\/([^/]+)\/([^/]+)$/);
  if (m) {
    const [, entityType, entityId] = m;
    if (!isValidEntityType(entityType)) return null;
    const entry = await getEntityIndexEntry(userId, entityType, entityId);
    if (!entry) return null;
    return { mimeType: 'application/json', text: JSON.stringify(entry, null, 2) };
  }

  m = uri.match(/^solytiq:\/\/graph\/([^/]+)$/);
  if (m) {
    const [, workspaceId] = m;
    if (!(await userCanAccessWorkspace(userId, workspaceId))) return null;
    const nodesRes = await query<{ entity_type: string; entity_id: string; title: string; deep_link: string | null }>(
      `SELECT e.entity_type, e.entity_id, e.title, e.deep_link FROM entity_index e
        WHERE e.workspace_id = $1 AND ${visibleCondition('e', 2)} LIMIT $3`,
      [workspaceId, userId, GRAPH_RESOURCE_NODE_CAP]
    );
    const nodeKeys = new Set(nodesRes.rows.map((n) => `${n.entity_type}:${n.entity_id}`));
    const edgesRes = await query<{ id: string; src_type: string; src_id: string; dst_type: string; dst_id: string; link_type: string; origin: string }>(
      `SELECT id, src_type, src_id, dst_type, dst_id, link_type, origin FROM entity_links WHERE workspace_id = $1 LIMIT 1000`,
      [workspaceId]
    );
    const edges = edgesRes.rows.filter((e) => nodeKeys.has(`${e.src_type}:${e.src_id}`) && nodeKeys.has(`${e.dst_type}:${e.dst_id}`));
    return {
      mimeType: 'application/json',
      text: JSON.stringify({
        nodes: nodesRes.rows.map((n) => ({ srn: `srn:${n.entity_type}:${n.entity_id}`, type: n.entity_type, title: n.title, deepLink: n.deep_link })),
        edges: edges.map((e) => ({ id: e.id, src: `srn:${e.src_type}:${e.src_id}`, dst: `srn:${e.dst_type}:${e.dst_id}`, linkType: e.link_type, origin: e.origin })),
        truncated: nodesRes.rows.length >= GRAPH_RESOURCE_NODE_CAP,
      }, null, 2),
    };
  }

  m = uri.match(/^solytiq:\/\/knowledge\/([^/]+)\/glossary$/);
  if (m) {
    const [, workspaceId] = m;
    if (!(await userCanAccessWorkspace(userId, workspaceId))) return null;
    return { mimeType: 'application/json', text: JSON.stringify({ terms: await listGlossary(workspaceId) }, null, 2) };
  }

  m = uri.match(/^solytiq:\/\/knowledge\/([^/]+)\/term\/(.+)$/);
  if (m) {
    const [, workspaceId, rawTerm] = m;
    if (!(await userCanAccessWorkspace(userId, workspaceId))) return null;
    // A not-defined term is a legitimate READ RESULT, not a missing resource:
    // "this workspace has no definition for X" is exactly what the caller needs
    // to know, and 404ing it would look identical to a permission failure.
    const result = await lookupTerm(workspaceId, decodeURIComponent(rawTerm));
    return { mimeType: 'application/json', text: JSON.stringify(result, null, 2) };
  }

  m = uri.match(/^solytiq:\/\/agent\/([^/]+)\/runs$/);
  if (m) {
    const [, workspaceId] = m;
    if (!(await userCanAccessWorkspace(userId, workspaceId))) return null;
    const r = await query<{ id: string; goal: string; status: string; mode: string; started_at: string; finished_at: string | null }>(
      `SELECT id, goal, status, mode, started_at, finished_at FROM agent_runs WHERE workspace_id = $1 ORDER BY started_at DESC LIMIT 20`,
      [workspaceId]
    );
    return { mimeType: 'application/json', text: JSON.stringify(r.rows, null, 2) };
  }

  return null;
}
