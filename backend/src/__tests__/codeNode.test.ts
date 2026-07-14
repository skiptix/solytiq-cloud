import { describe, expect, it } from 'vitest';
import { runSandboxedCode, MAX_CODE_LENGTH } from '../codeNode';
import type { ExpressionScope } from '../automationExpressions';

const emptyScope: ExpressionScope = { trigger: null, $json: null, nodes: {} };

describe('runSandboxedCode', () => {
  it('runs simple code and returns a JSON-serializable value', async () => {
    const result = await runSandboxedCode('return { hello: "world", n: 1 + 1 };', emptyScope);
    expect(result).toEqual({ ok: true, output: { hello: 'world', n: 2 } });
  });

  it('exposes trigger/$json/nodes via the `input` global', async () => {
    const scope: ExpressionScope = {
      trigger: { task: { title: 'Milk' } },
      $json: { status: 'ok' },
      nodes: { trig_1: { task: { title: 'Milk' } } },
    };
    const result = await runSandboxedCode(
      'return { title: input.trigger.task.title.toUpperCase(), status: input.$json.status, fromNodes: input.nodes.trig_1.task.title };',
      scope
    );
    expect(result).toEqual({ ok: true, output: { title: 'MILK', status: 'ok', fromNodes: 'Milk' } });
  });

  it('returns null when the code has no return statement', async () => {
    const result = await runSandboxedCode('const x = 1;', emptyScope);
    expect(result).toEqual({ ok: true, output: null });
  });

  it('has no access to require/process/fetch/filesystem — pure ECMAScript only', async () => {
    const result = await runSandboxedCode(
      'return { hasProcess: typeof process, hasRequire: typeof require, hasFetch: typeof fetch, hasGlobalThis: typeof globalThis };',
      emptyScope
    );
    expect(result).toEqual({
      ok: true,
      output: { hasProcess: 'undefined', hasRequire: 'undefined', hasFetch: 'undefined', hasGlobalThis: 'object' },
    });
  });

  it('enforces the CPU-time timeout on an infinite loop', async () => {
    const result = await runSandboxedCode('while (true) {}', emptyScope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/timed out/i);
  }, 10_000);

  it('reports a clean error for a syntax error instead of throwing out of the function', async () => {
    const result = await runSandboxedCode('this is not valid javascript', emptyScope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Code error/);
  });

  it('reports a clean error for a runtime error (e.g. calling a method on undefined)', async () => {
    const result = await runSandboxedCode('return input.trigger.task.title.toUpperCase();', emptyScope);
    expect(result.ok).toBe(false);
  });

  it('drops undefined-valued properties, matching normal JSON semantics', async () => {
    const result = await runSandboxedCode('return { a: 1, b: undefined };', emptyScope);
    expect(result).toEqual({ ok: true, output: { a: 1 } });
  });

  it('reports a clean error rather than leaking a function reference out of the sandbox', async () => {
    const result = await runSandboxedCode('return { a: 1, c: function() {} };', emptyScope);
    expect(result.ok).toBe(false);
  });

  it('rejects code longer than the maximum length up front', async () => {
    const result = await runSandboxedCode('return 1; //' + 'x'.repeat(MAX_CODE_LENGTH), emptyScope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/must be under/);
  });
});
