// ---------------------------------------------------------------------------
// Agent Runtime — policy engine. Pure, side-effect-free decision logic: given
// a workspace's agent_mode + agent_policy (JSONB), decide whether a given
// tool call is allowed at all, and whether it needs a human's sign-off
// (an agent_proposals row) before it may execute. No DB, no HTTP — runtime.ts
// is the only caller, and is what actually enforces these decisions.
// ---------------------------------------------------------------------------

export type AgentMode = 'off' | 'suggest' | 'assisted' | 'autonomous';

export interface AgentPolicy {
  allowedTools?: string[];
  autoApproveTools?: string[];
  deniedTools?: string[];
  maxActionsPerRun?: number;
  maxToolCallsPerRun?: number;
  dailyTokenBudget?: number;
  allowedLinkTypes?: string[];
  allowCrossWorkspace?: boolean;
  requireApprovalOver?: { taskCount?: number; deleteAny?: boolean };
  model?: string | null;
}

export const DEFAULT_AGENT_POLICY: Required<Pick<AgentPolicy, 'maxActionsPerRun' | 'maxToolCallsPerRun'>> & AgentPolicy = {
  allowedTools: [],
  autoApproveTools: [],
  deniedTools: [],
  maxActionsPerRun: 10,
  maxToolCallsPerRun: 20,
  dailyTokenBudget: 0,
  allowedLinkTypes: [],
  allowCrossWorkspace: false,
  requireApprovalOver: { deleteAny: true },
  model: null,
};

/** Merge a raw (possibly partial/malformed) stored policy over the defaults — never trust JSONB shape blindly. */
export function parseAgentPolicy(raw: unknown): AgentPolicy {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_AGENT_POLICY };
  const r = raw as Record<string, unknown>;
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
  const approvalOver = r.requireApprovalOver && typeof r.requireApprovalOver === 'object' ? (r.requireApprovalOver as Record<string, unknown>) : {};
  return {
    allowedTools: arr(r.allowedTools),
    autoApproveTools: arr(r.autoApproveTools),
    deniedTools: arr(r.deniedTools),
    maxActionsPerRun: num(r.maxActionsPerRun, DEFAULT_AGENT_POLICY.maxActionsPerRun),
    maxToolCallsPerRun: num(r.maxToolCallsPerRun, DEFAULT_AGENT_POLICY.maxToolCallsPerRun),
    dailyTokenBudget: num(r.dailyTokenBudget, 0),
    allowedLinkTypes: arr(r.allowedLinkTypes),
    allowCrossWorkspace: r.allowCrossWorkspace === true,
    requireApprovalOver: {
      taskCount: typeof approvalOver.taskCount === 'number' ? approvalOver.taskCount : undefined,
      deleteAny: approvalOver.deleteAny !== false, // defaults ON — an explicit `false` is required to relax it
    },
    model: typeof r.model === 'string' ? r.model : null,
  };
}

/** Is this tool usable AT ALL under this policy? Deny always wins over allow. An empty allow-list means "everything not denied". */
export function canUseTool(policy: AgentPolicy, toolName: string): boolean {
  if (policy.deniedTools?.includes(toolName)) return false;
  if (policy.allowedTools?.length) return policy.allowedTools.includes(toolName);
  return true;
}

/**
 * Would this specific call need a human's sign-off before running, given the
 * workspace's current mode? `off` is handled by the caller (a run should
 * never even start) — this only decides suggest/assisted/autonomous.
 */
export function needsApproval(mode: AgentMode, policy: AgentPolicy, toolName: string, args: Record<string, unknown>): boolean {
  if (mode === 'suggest') return true;
  // A destructive call is gated regardless of mode unless the policy explicitly relaxed it.
  if (policy.requireApprovalOver?.deleteAny && toolName.startsWith('delete_')) return true;
  const taskCountLimit = policy.requireApprovalOver?.taskCount;
  if (typeof taskCountLimit === 'number' && typeof args.task_ids === 'object' && Array.isArray(args.task_ids) && args.task_ids.length > taskCountLimit) {
    return true;
  }
  if (mode === 'autonomous') return false;
  // assisted: only pre-approved tools run without a human in the loop.
  return !policy.autoApproveTools?.includes(toolName);
}

/** A run has burned through its budget for this call type — stop calling tools (not an error, a soft ceiling). */
export function exceedsRunLimits(policy: AgentPolicy, toolCallsSoFar: number, actionsSoFar: number): boolean {
  const maxCalls = policy.maxToolCallsPerRun ?? DEFAULT_AGENT_POLICY.maxToolCallsPerRun;
  const maxActions = policy.maxActionsPerRun ?? DEFAULT_AGENT_POLICY.maxActionsPerRun;
  return toolCallsSoFar >= maxCalls || actionsSoFar >= maxActions;
}
