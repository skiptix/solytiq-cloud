import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── db mock: a REAL (in-memory) BEGIN/COMMIT/ROLLBACK simulation, not a
// no-op stub — this lets us verify runActionTransaction's actual rollback
// behavior (each action gets its own self-contained transaction; a failure
// in a LATER node must not touch an EARLIER node's already-committed work).
const queryMock = vi.fn(async () => ({ rows: [], rowCount: 0 }));
const dbCalls: string[] = [];
const withTransactionMock = vi.fn(async (fn: (client: { query: (text: string, params?: unknown[]) => Promise<unknown> }) => Promise<unknown>) => {
  dbCalls.push('BEGIN');
  const client = { query: vi.fn(async (text: string) => { dbCalls.push(text); return { rows: [], rowCount: 0 }; }) };
  try {
    const result = await fn(client);
    dbCalls.push('COMMIT');
    return result;
  } catch (err) {
    dbCalls.push('ROLLBACK');
    throw err;
  }
});
vi.mock('../db', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  withTransaction: (...args: [any]) => withTransactionMock(...args),
}));

// ── automationTypes mock: a controllable trigger/action registry. Both
// automationEngine.ts AND automationGraph.ts import getTriggerDef/getActionDef
// from '../automationTypes', so mocking it here makes normalizeAutomationGraph
// (used internally by runAutomation) see the exact same test doubles.
const registry = vi.hoisted(() => {
  class ActionRollbackSignal extends Error {
    constructor(public readonly result: unknown) {
      super('automation action requested rollback');
    }
  }
  return {
    triggers: {} as Record<string, any>,
    actions: {} as Record<string, any>,
    ActionRollbackSignal,
  };
});
vi.mock('../automationTypes', () => ({
  getTriggerDef: (id: string) => registry.triggers[id],
  getActionDef: (id: string) => registry.actions[id],
  serializeTriggerOutput: (triggerType: string, ctx: unknown) => ({ triggerType, ctx }),
  ActionRollbackSignal: registry.ActionRollbackSignal,
  resolveRequirement: (flag: unknown, params: Record<string, unknown>) => (typeof flag === 'function' ? flag(params) : !!flag),
}));

// vi.mock calls are hoisted above imports, so these static imports already see
// the mocked ../db and ../automationTypes modules. automationGraph.ts and
// automationExpressions.ts are used for real (pure, no side effects).
import { fireTrigger, scopeMatches, computeNextFireAt, runAutomation } from '../automationEngine';

function trigger(id: string, overrides: Record<string, unknown> = {}) {
  return { id, label: id, description: '', icon: 'x', paramsSchema: { type: 'object', properties: {} }, providesTask: false, providesList: false, validate: () => null, ...overrides };
}
function action(id: string, execute: (ctx: any, params: Record<string, unknown>) => Promise<any>, overrides: Record<string, unknown> = {}) {
  return { id, label: id, description: '', icon: 'x', paramsSchema: { type: 'object', properties: {} }, validate: () => null, execute, ...overrides };
}

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  withTransactionMock.mockClear();
  dbCalls.length = 0;
  registry.triggers = {};
  registry.actions = {};
});

describe('fireTrigger — loop prevention', () => {
  it('is a complete no-op for an automation-originated actor: it never touches the database', async () => {
    await fireTrigger(
      'task_created',
      { workspaceId: 'ws_1', task: { id: '1', title: 'x', listId: 'list_1', checked: false }, list: { id: 'list_1', name: 'L' } },
      { type: 'automation', automationId: 'automation_x', runId: 'run_x' }
    );
    // The entire loop-prevention guarantee rests on this: no lookup, so no
    // automation can ever be re-triggered by another automation's own writes.
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('looks up matching enabled automations for a genuine user action', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await fireTrigger(
      'task_created',
      { workspaceId: 'ws_1', task: { id: '1', title: 'x', listId: 'list_1', checked: false }, list: { id: 'list_1', name: 'L' } },
      { type: 'user', userId: 'user_1' }
    );
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/FROM automations/);
    expect(params).toEqual(['ws_1', 'task_created']);
  });
});

describe('scopeMatches', () => {
  const ctxWithList = { workspaceId: 'ws_1', list: { id: 'list_1', name: 'L' } };
  const ctxNoList = { workspaceId: 'ws_1' };

  it('task_completed/task_created match any list when scope.listId is unset', () => {
    expect(scopeMatches('task_completed', {}, ctxWithList)).toBe(true);
    expect(scopeMatches('task_created', {}, ctxWithList)).toBe(true);
  });

  it('task_completed/task_created only match the scoped list when scope.listId is set', () => {
    expect(scopeMatches('task_completed', { listId: 'list_1' }, ctxWithList)).toBe(true);
    expect(scopeMatches('task_completed', { listId: 'list_OTHER' }, ctxWithList)).toBe(false);
  });

  it('list_all_completed requires an exact listId match (no "any list" case)', () => {
    expect(scopeMatches('list_all_completed', { listId: 'list_1' }, ctxWithList)).toBe(true);
    expect(scopeMatches('list_all_completed', { listId: 'list_OTHER' }, ctxWithList)).toBe(false);
    expect(scopeMatches('list_all_completed', {}, ctxWithList)).toBe(false);
  });

  it('never matches a trigger event whose context has no list', () => {
    expect(scopeMatches('list_all_completed', { listId: 'list_1' }, ctxNoList)).toBe(false);
  });

  it('schedule never matches via fireTrigger\'s lookup path (fired only by the sweep)', () => {
    expect(scopeMatches('schedule', {}, ctxWithList)).toBe(false);
  });
});

describe('computeNextFireAt', () => {
  it('schedules the same day when the time is still ahead (daily)', () => {
    const from = new Date('2026-07-14T08:00:00Z');
    const next = computeNextFireAt({ freq: 'daily', time: '09:00' }, from);
    expect(next.getUTCHours()).toBe(9);
    expect(next.getUTCDate()).toBe(from.getUTCDate());
  });

  it('rolls over to the next day when the time has already passed (daily)', () => {
    const from = new Date('2026-07-14T10:00:00Z');
    const next = computeNextFireAt({ freq: 'daily', time: '09:00' }, from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect(next.getUTCDate()).toBe(from.getUTCDate() + 1);
  });

  it('finds the next matching weekday for weekly schedules', () => {
    const from = new Date('2026-07-14T00:00:00Z'); // a Tuesday
    const next = computeNextFireAt({ freq: 'weekly', time: '09:00', dayOfWeek: 5 }, from); // next Friday
    expect(next.getDay()).toBe(5);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });
});

describe('runAutomation — per-step execution & data flow', () => {
  const baseAutomation = { id: 'automation_1', workspace_id: 'ws_1', user_id: 'owner_1' };

  it('records the trigger as the first step, with its own output', async () => {
    registry.triggers.test_trigger = trigger('test_trigger');
    registry.actions.noop = action('noop', async () => ({ ok: true, summary: 'did nothing', output: { done: true } }));

    const graph = {
      version: 1 as const,
      nodes: [
        { id: 't1', kind: 'trigger' as const, type: 'test_trigger', position: { x: 0, y: 0 }, params: {} },
        { id: 'a1', kind: 'action' as const, type: 'noop', position: { x: 0, y: 0 }, params: {} },
      ],
      edges: [{ id: 'e1', source: 't1', target: 'a1' }],
    };

    const result = await runAutomation({ ...baseAutomation, graph }, 'test_trigger', { workspaceId: 'ws_1' });
    expect(result.status).toBe('success');
    expect(result.steps[0]).toMatchObject({ nodeId: 't1', actionType: 'test_trigger', ok: true });
    expect(result.steps[0].output).toEqual({ triggerType: 'test_trigger', ctx: { workspaceId: 'ws_1' } });
    expect(result.steps[1]).toMatchObject({ nodeId: 'a1', ok: true, output: { done: true } });
  });

  it('propagates an earlier node\'s output into a later node via {{$json...}}', async () => {
    registry.triggers.test_trigger = trigger('test_trigger');
    registry.actions.produce = action('produce', async () => ({ ok: true, summary: 'produced', output: { value: 'A-RESULT' } }));
    let seenByConsumer: unknown;
    registry.actions.consume = action('consume', async (_ctx, params) => {
      seenByConsumer = params.input;
      return { ok: true, summary: 'consumed', output: { seen: params.input } };
    }, { paramsSchema: { type: 'object', properties: { input: { type: 'string', label: 'Input', description: '' } } } });

    const graph = {
      version: 1 as const,
      nodes: [
        { id: 't1', kind: 'trigger' as const, type: 'test_trigger', position: { x: 0, y: 0 }, params: {} },
        { id: 'a1', kind: 'action' as const, type: 'produce', position: { x: 0, y: 0 }, params: {} },
        { id: 'a2', kind: 'action' as const, type: 'consume', position: { x: 0, y: 0 }, params: { input: '{{$json.value}}' } },
      ],
      edges: [{ id: 'e1', source: 't1', target: 'a1' }, { id: 'e2', source: 'a1', target: 'a2' }],
    };

    const result = await runAutomation({ ...baseAutomation, graph }, 'test_trigger', { workspaceId: 'ws_1' });
    expect(result.status).toBe('success');
    expect(seenByConsumer).toBe('A-RESULT');
    expect(result.steps[2].output).toEqual({ seen: 'A-RESULT' });
  });

  it('a failing node stops the chain and does NOT run subsequent nodes, but does not "undo" earlier recorded successes', async () => {
    registry.triggers.test_trigger = trigger('test_trigger');
    registry.actions.ok_step = action('ok_step', async () => ({ ok: true, summary: 'fine', output: { x: 1 } }));
    registry.actions.fail_step = action('fail_step', async () => ({ ok: false, summary: 'boom', error: 'boom' }));
    const neverRuns = vi.fn(async () => ({ ok: true, summary: 'should never happen' }));
    registry.actions.never_step = action('never_step', neverRuns);

    const graph = {
      version: 1 as const,
      nodes: [
        { id: 't1', kind: 'trigger' as const, type: 'test_trigger', position: { x: 0, y: 0 }, params: {} },
        { id: 'a1', kind: 'action' as const, type: 'ok_step', position: { x: 0, y: 0 }, params: {} },
        { id: 'a2', kind: 'action' as const, type: 'fail_step', position: { x: 0, y: 0 }, params: {} },
        { id: 'a3', kind: 'action' as const, type: 'never_step', position: { x: 0, y: 0 }, params: {} },
      ],
      edges: [{ id: 'e1', source: 't1', target: 'a1' }, { id: 'e2', source: 'a1', target: 'a2' }, { id: 'e3', source: 'a2', target: 'a3' }],
    };

    const result = await runAutomation({ ...baseAutomation, graph }, 'test_trigger', { workspaceId: 'ws_1' });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('boom');
    expect(neverRuns).not.toHaveBeenCalled();
    expect(result.steps).toHaveLength(3); // trigger + ok_step + fail_step — never_step never even gets a step entry
    expect(result.steps[1]).toMatchObject({ nodeId: 'a1', ok: true }); // still recorded as a genuine success
    expect(result.steps[2]).toMatchObject({ nodeId: 'a2', ok: false });
  });

  it('per-step atomicity: an earlier action\'s own transaction COMMITs independently of a later action failing', async () => {
    registry.triggers.test_trigger = trigger('test_trigger');
    registry.actions.writer = action('writer', async (ctx) =>
      ctx.withTransaction(async (exec: any) => {
        await exec('INSERT INTO widgets ...');
        return { ok: true, summary: 'wrote', output: {} };
      })
    );
    registry.actions.fail_step = action('fail_step', async () => ({ ok: false, summary: 'boom', error: 'boom' }));

    const graph = {
      version: 1 as const,
      nodes: [
        { id: 't1', kind: 'trigger' as const, type: 'test_trigger', position: { x: 0, y: 0 }, params: {} },
        { id: 'a1', kind: 'action' as const, type: 'writer', position: { x: 0, y: 0 }, params: {} },
        { id: 'a2', kind: 'action' as const, type: 'fail_step', position: { x: 0, y: 0 }, params: {} },
      ],
      edges: [{ id: 'e1', source: 't1', target: 'a1' }, { id: 'e2', source: 'a1', target: 'a2' }],
    };

    const result = await runAutomation({ ...baseAutomation, graph }, 'test_trigger', { workspaceId: 'ws_1' });
    expect(result.status).toBe('failed');
    // a1's own transaction opened, wrote, and committed — a2 failing afterwards
    // (which never even opens ctx.withTransaction) cannot and does not touch it.
    expect(dbCalls).toEqual(['BEGIN', 'INSERT INTO widgets ...', 'COMMIT']);
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('ctx.withTransaction forces a ROLLBACK when the wrapped action returns {ok: false} (not just when it throws)', async () => {
    registry.triggers.test_trigger = trigger('test_trigger');
    registry.actions.txn_fail = action('txn_fail', async (ctx) =>
      ctx.withTransaction(async (exec: any) => {
        await exec('INSERT INTO widgets ...');
        return { ok: false, summary: 'validation failed after the write', error: 'validation failed after the write' };
      })
    );

    const graph = {
      version: 1 as const,
      nodes: [
        { id: 't1', kind: 'trigger' as const, type: 'test_trigger', position: { x: 0, y: 0 }, params: {} },
        { id: 'a1', kind: 'action' as const, type: 'txn_fail', position: { x: 0, y: 0 }, params: {} },
      ],
      edges: [{ id: 'e1', source: 't1', target: 'a1' }],
    };

    const result = await runAutomation({ ...baseAutomation, graph }, 'test_trigger', { workspaceId: 'ws_1' });
    expect(result.status).toBe('failed');
    expect(dbCalls).toEqual(['BEGIN', 'INSERT INTO widgets ...', 'ROLLBACK']);
    expect(result.steps[1]).toMatchObject({ nodeId: 'a1', ok: false, error: 'validation failed after the write' });
  });

  it('an action throwing an unexpected error is caught and recorded as a failed step, not propagated', async () => {
    registry.triggers.test_trigger = trigger('test_trigger');
    registry.actions.throws = action('throws', async () => {
      throw new Error('unexpected DB error');
    });

    const graph = {
      version: 1 as const,
      nodes: [
        { id: 't1', kind: 'trigger' as const, type: 'test_trigger', position: { x: 0, y: 0 }, params: {} },
        { id: 'a1', kind: 'action' as const, type: 'throws', position: { x: 0, y: 0 }, params: {} },
      ],
      edges: [{ id: 'e1', source: 't1', target: 'a1' }],
    };

    const result = await runAutomation({ ...baseAutomation, graph }, 'test_trigger', { workspaceId: 'ws_1' });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('unexpected DB error');
  });
});
