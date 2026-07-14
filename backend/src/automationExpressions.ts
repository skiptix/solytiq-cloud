// ---------------------------------------------------------------------------
// Automation Hub — expression resolution ("data flow between nodes").
//
// Every node (the trigger, and every action) produces a JSON `output` after
// it runs (automationEngine.ts accumulates these into a `nodeOutputs` map,
// keyed by node id). A later node's string params can reference any earlier
// node's output via a tiny `{{...}}` token syntax:
//   {{trigger.task.title}}      — the trigger's own output
//   {{$json.status}}            — the immediately-preceding node's output
//   {{nodes.node_123.output}}   — any specific earlier node, by id
//
// SECURITY: this is a plain, eval-free property-path walker — not a template
// language and definitely not JS. A malicious-looking token like
// `{{constructor.constructor('return process')()}}` cannot execute anything:
// the character whitelist below rejects `(`/`)`/`'`/` ` outright, and even if
// it didn't, resolution only ever does `obj[key]` property reads, never
// `Function`/`eval`/`new`. Real JS execution is the separate, deliberately
// sandboxed Code node (see the `code` action in automationTypes.ts).
// ---------------------------------------------------------------------------

export interface ExpressionScope {
  /** The trigger node's own output (the task/list/folder/workspace that fired it). */
  trigger: unknown;
  /** Shorthand for the immediately-preceding node's output. */
  $json: unknown;
  /** Every node's output so far this run, keyed by node id (includes the trigger, under its node id). */
  nodes: Record<string, unknown>;
}

export function buildScope(
  nodeOutputs: Record<string, unknown>,
  triggerNodeId: string,
  previousNodeId: string
): ExpressionScope {
  return {
    trigger: nodeOutputs[triggerNodeId],
    $json: nodeOutputs[previousNodeId],
    nodes: nodeOutputs,
  };
}

// Only these characters may appear inside a {{...}} token. No spaces, quotes,
// parens, or operators — a well-formed path is the only thing that can ever
// resolve to something; anything else is inert.
const SAFE_EXPR_RE = /^[A-Za-z0-9_$.[\]]+$/;
const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

function parsePath(expr: string): (string | number)[] {
  const path: (string | number)[] = [];
  for (const segment of expr.split('.')) {
    const m = /^([A-Za-z0-9_$]*)((?:\[\d+\])*)$/.exec(segment);
    if (!m) return [];
    if (m[1]) path.push(m[1]);
    const idxRe = /\[(\d+)\]/g;
    let im: RegExpExecArray | null;
    while ((im = idxRe.exec(m[2]))) path.push(Number(im[1]));
  }
  return path;
}

function getByPath(root: unknown, path: (string | number)[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof key === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[key];
    } else {
      if (typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[key];
    }
  }
  return cur;
}

function resolveToken(rawExpr: string, scope: ExpressionScope): string {
  const expr = rawExpr.trim();
  if (!SAFE_EXPR_RE.test(expr)) return '';
  const path = parsePath(expr);
  if (path.length === 0) return '';

  const [rootKey, ...rest] = path;
  let root: unknown;
  if (rootKey === 'trigger') root = scope.trigger;
  else if (rootKey === '$json') root = scope.$json;
  else if (rootKey === 'nodes') root = scope.nodes;
  else return '';

  const value = getByPath(root, rest);
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/** Replace every {{...}} token in a string with its resolved value (empty string if unresolvable). */
export function substituteString(input: string, scope: ExpressionScope): string {
  return input.replace(TOKEN_RE, (_match, expr: string) => resolveToken(expr, scope));
}

function resolveValue(value: unknown, scope: ExpressionScope): unknown {
  if (typeof value === 'string') return substituteString(value, scope);
  if (Array.isArray(value)) {
    return value.map((item) => {
      // The isKeyValue param shape: an array of { key, value } string pairs.
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>;
        const out: Record<string, unknown> = { ...obj };
        if (typeof obj.key === 'string') out.key = substituteString(obj.key, scope);
        if (typeof obj.value === 'string') out.value = substituteString(obj.value, scope);
        return out;
      }
      return resolveValue(item, scope);
    });
  }
  return value;
}

/**
 * Resolve every {{...}} token in a node's params against `scope`, before
 * validate()/execute() ever see them. `skipKeys` exempts params that are raw
 * source rather than a template string (the Code action's `code` param).
 */
export function resolveExpressions(
  params: Record<string, unknown>,
  scope: ExpressionScope,
  skipKeys: ReadonlySet<string> = new Set()
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    result[key] = skipKeys.has(key) ? value : resolveValue(value, scope);
  }
  return result;
}
