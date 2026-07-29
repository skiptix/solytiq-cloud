import { describe, expect, it } from 'vitest';
import { parseAgentPolicy, canUseTool, needsApproval, exceedsRunLimits, DEFAULT_AGENT_POLICY } from '../agent/policy';

describe('parseAgentPolicy', () => {
  it('fills in every field with sane defaults for null/garbage input', () => {
    expect(parseAgentPolicy(null)).toEqual(DEFAULT_AGENT_POLICY);
    expect(parseAgentPolicy(undefined)).toEqual(DEFAULT_AGENT_POLICY);
    expect(parseAgentPolicy('not an object')).toEqual(DEFAULT_AGENT_POLICY);
  });

  it('preserves valid fields and drops malformed ones', () => {
    const policy = parseAgentPolicy({
      allowedTools: ['create_task', 42, 'update_task'],
      maxActionsPerRun: 'not a number',
      dailyTokenBudget: 5000,
    });
    expect(policy.allowedTools).toEqual(['create_task', 'update_task']);
    expect(policy.maxActionsPerRun).toBe(DEFAULT_AGENT_POLICY.maxActionsPerRun);
    expect(policy.dailyTokenBudget).toBe(5000);
  });

  it('requireApprovalOver.deleteAny defaults ON unless explicitly relaxed', () => {
    expect(parseAgentPolicy({}).requireApprovalOver?.deleteAny).toBe(true);
    expect(parseAgentPolicy({ requireApprovalOver: { deleteAny: false } }).requireApprovalOver?.deleteAny).toBe(false);
  });

  it('rejects a negative maxActionsPerRun back to the default', () => {
    expect(parseAgentPolicy({ maxActionsPerRun: -5 }).maxActionsPerRun).toBe(DEFAULT_AGENT_POLICY.maxActionsPerRun);
  });
});

describe('canUseTool', () => {
  it('allows everything when both lists are empty', () => {
    expect(canUseTool({}, 'create_task')).toBe(true);
  });

  it('deny always wins, even if also on the allow-list', () => {
    expect(canUseTool({ allowedTools: ['create_task'], deniedTools: ['create_task'] }, 'create_task')).toBe(false);
  });

  it('a non-empty allow-list excludes everything not on it', () => {
    const policy = { allowedTools: ['create_task'] };
    expect(canUseTool(policy, 'create_task')).toBe(true);
    expect(canUseTool(policy, 'delete_task')).toBe(false);
  });
});

describe('needsApproval', () => {
  const policy = parseAgentPolicy({});

  it('suggest mode always requires approval, for any tool', () => {
    expect(needsApproval('suggest', policy, 'create_task', {})).toBe(true);
    expect(needsApproval('suggest', policy, 'list_tasks', {})).toBe(true);
  });

  it('autonomous mode never requires approval, except a delete when deleteAny is on', () => {
    expect(needsApproval('autonomous', policy, 'create_task', {})).toBe(false);
    expect(needsApproval('autonomous', policy, 'delete_task', {})).toBe(true);
  });

  it('autonomous mode allows deletes once the policy explicitly relaxes deleteAny', () => {
    const relaxed = parseAgentPolicy({ requireApprovalOver: { deleteAny: false } });
    expect(needsApproval('autonomous', relaxed, 'delete_task', {})).toBe(false);
  });

  it('assisted mode only auto-runs tools on the auto-approve list', () => {
    const assistedPolicy = parseAgentPolicy({ autoApproveTools: ['create_task'], requireApprovalOver: { deleteAny: false } });
    expect(needsApproval('assisted', assistedPolicy, 'create_task', {})).toBe(false);
    expect(needsApproval('assisted', assistedPolicy, 'update_task', {})).toBe(true);
  });

  it('a delete is gated in assisted mode even if on the auto-approve list, when deleteAny is on', () => {
    const p = parseAgentPolicy({ autoApproveTools: ['delete_task'] });
    expect(needsApproval('assisted', p, 'delete_task', {})).toBe(true);
  });
});

describe('exceedsRunLimits', () => {
  it('stops once either the tool-call or action ceiling is reached', () => {
    const policy = parseAgentPolicy({ maxToolCallsPerRun: 5, maxActionsPerRun: 3 });
    expect(exceedsRunLimits(policy, 4, 2)).toBe(false);
    expect(exceedsRunLimits(policy, 5, 2)).toBe(true);
    expect(exceedsRunLimits(policy, 4, 3)).toBe(true);
  });
});
