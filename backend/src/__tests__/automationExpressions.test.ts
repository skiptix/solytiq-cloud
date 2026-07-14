import { describe, expect, it } from 'vitest';
import { buildScope, resolveExpressions, substituteString } from '../automationExpressions';

describe('buildScope', () => {
  it('exposes trigger, $json (previous node), and the full nodes map', () => {
    const nodeOutputs = {
      trig_1: { task: { title: 'Milk' } },
      action_1: { status: 'done' },
    };
    const scope = buildScope(nodeOutputs, 'trig_1', 'action_1');
    expect(scope.trigger).toEqual({ task: { title: 'Milk' } });
    expect(scope.$json).toEqual({ status: 'done' });
    expect(scope.nodes).toBe(nodeOutputs);
  });

  it('$json falls back to the trigger output when there is no previous action yet', () => {
    const nodeOutputs = { trig_1: { list: { name: 'Groceries' } } };
    const scope = buildScope(nodeOutputs, 'trig_1', 'trig_1');
    expect(scope.$json).toEqual(scope.trigger);
  });
});

describe('substituteString', () => {
  const scope = buildScope(
    {
      trig_1: { task: { title: 'Milk', count: 3, done: false }, list: { name: 'Groceries' } },
      action_1: { status: 'ok', items: ['a', 'b'] },
    },
    'trig_1',
    'action_1'
  );

  it('resolves a simple trigger path', () => {
    expect(substituteString('Buy {{trigger.task.title}}', scope)).toBe('Buy Milk');
  });

  it('resolves $json (previous node output)', () => {
    expect(substituteString('status={{$json.status}}', scope)).toBe('status=ok');
  });

  it('resolves nodes.<id> (any earlier node, by id)', () => {
    expect(substituteString('{{nodes.action_1.status}}', scope)).toBe('ok');
  });

  it('stringifies numbers and booleans', () => {
    expect(substituteString('count={{trigger.task.count}} done={{trigger.task.done}}', scope)).toBe('count=3 done=false');
  });

  it('JSON-stringifies object/array values', () => {
    expect(substituteString('{{trigger.list}}', scope)).toBe('{"name":"Groceries"}');
    expect(substituteString('{{$json.items}}', scope)).toBe('["a","b"]');
  });

  it('resolves array indices', () => {
    expect(substituteString('{{$json.items[1]}}', scope)).toBe('b');
  });

  it('substitutes multiple tokens in one string', () => {
    expect(substituteString('{{trigger.task.title}} x{{trigger.task.count}}', scope)).toBe('Milk x3');
  });

  it('resolves an unknown/missing path to an empty string', () => {
    expect(substituteString('[{{trigger.task.nope}}]', scope)).toBe('[]');
    expect(substituteString('[{{nodes.unknown_node.foo}}]', scope)).toBe('[]');
  });

  it('leaves a string with no tokens untouched', () => {
    expect(substituteString('plain text', scope)).toBe('plain text');
  });

  it('cannot execute anything — a malicious-looking token just fails to resolve', () => {
    // Parens/quotes/spaces are outside the character whitelist, so this can
    // never reach anything beyond "resolve to empty string". There is no
    // eval/Function in the resolver at all.
    expect(substituteString("{{constructor.constructor('return process')()}}", scope)).toBe('');
    expect(substituteString('{{trigger["task"]["title"]}}', scope)).toBe(''); // bracketed string keys are not supported either
  });

  it('rejects an unknown root key', () => {
    expect(substituteString('{{secrets.apiKey}}', scope)).toBe('');
  });
});

describe('resolveExpressions', () => {
  const scope = buildScope({ trig_1: { task: { title: 'Milk' } } }, 'trig_1', 'trig_1');

  it('substitutes every string param', () => {
    const resolved = resolveExpressions({ title: 'Buy {{trigger.task.title}}', count: 3, flag: true }, scope);
    expect(resolved).toEqual({ title: 'Buy Milk', count: 3, flag: true });
  });

  it('substitutes key/value pair arrays (the isKeyValue param shape)', () => {
    const resolved = resolveExpressions(
      { headers: [{ key: 'X-Task', value: '{{trigger.task.title}}' }, { key: 'X-Static', value: 'v' }] },
      scope
    );
    expect(resolved.headers).toEqual([
      { key: 'X-Task', value: 'Milk' },
      { key: 'X-Static', value: 'v' },
    ]);
  });

  it('exempts skipKeys (e.g. the Code action\'s raw `code` param) from substitution', () => {
    const resolved = resolveExpressions(
      { code: 'return { x: "{{trigger.task.title}}" };', other: '{{trigger.task.title}}' },
      scope,
      new Set(['code'])
    );
    expect(resolved.code).toBe('return { x: "{{trigger.task.title}}" };');
    expect(resolved.other).toBe('Milk');
  });
});
