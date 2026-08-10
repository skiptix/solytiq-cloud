// ---------------------------------------------------------------------------
// B8 — pool/timeout configuration resolution. Pure, no DB.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { resolvePoolConfig, resolveReadyzTimeoutMillis, resolveShutdownDeadlineMillis } from '../dbConfig';

describe('resolvePoolConfig', () => {
  it('returns sane, bounded defaults when nothing is configured', () => {
    const cfg = resolvePoolConfig({});
    expect(cfg.max).toBeGreaterThan(0);
    expect(cfg.connectionTimeoutMillis).toBeGreaterThan(0); // never "wait forever" by default
    expect(cfg.statementTimeoutMillis).toBeGreaterThan(0);
    expect(cfg.lockTimeoutMillis).toBeGreaterThan(0);
    expect(cfg.idleTimeoutMillis).toBeGreaterThanOrEqual(0);
    expect(cfg.idleInTransactionSessionTimeoutMillis).toBeGreaterThan(0);
  });

  it('honors every env override', () => {
    const cfg = resolvePoolConfig({
      DB_POOL_MAX: '5',
      DB_POOL_IDLE_TIMEOUT_MS: '1000',
      DB_POOL_ACQUIRE_TIMEOUT_MS: '2000',
      DB_STATEMENT_TIMEOUT_MS: '3000',
      DB_LOCK_TIMEOUT_MS: '4000',
      DB_IDLE_IN_TXN_TIMEOUT_MS: '5000',
    });
    expect(cfg).toEqual({
      max: 5,
      idleTimeoutMillis: 1000,
      connectionTimeoutMillis: 2000,
      statementTimeoutMillis: 3000,
      lockTimeoutMillis: 4000,
      idleInTransactionSessionTimeoutMillis: 5000,
    });
  });

  it('falls back to the default for a non-numeric value rather than throwing or producing NaN', () => {
    const cfg = resolvePoolConfig({ DB_POOL_MAX: 'not-a-number' });
    expect(cfg.max).toBe(20);
    expect(Number.isFinite(cfg.max)).toBe(true);
  });

  it('rejects a zero/negative value for a field that must be positive (falls back to default)', () => {
    expect(resolvePoolConfig({ DB_POOL_MAX: '0' }).max).toBe(20);
    expect(resolvePoolConfig({ DB_POOL_MAX: '-5' }).max).toBe(20);
    expect(resolvePoolConfig({ DB_POOL_ACQUIRE_TIMEOUT_MS: '0' }).connectionTimeoutMillis).toBe(10_000);
  });

  it('allows an explicit 0 (disabled) for statement/lock/idle-in-txn timeouts — a deliberate opt-out, not a default', () => {
    const cfg = resolvePoolConfig({ DB_STATEMENT_TIMEOUT_MS: '0', DB_LOCK_TIMEOUT_MS: '0', DB_IDLE_IN_TXN_TIMEOUT_MS: '0' });
    expect(cfg.statementTimeoutMillis).toBe(0);
    expect(cfg.lockTimeoutMillis).toBe(0);
    expect(cfg.idleInTransactionSessionTimeoutMillis).toBe(0);
  });
});

describe('resolveReadyzTimeoutMillis / resolveShutdownDeadlineMillis', () => {
  it('default readyz timeout is short (bounds the 5s readiness gate)', () => {
    expect(resolveReadyzTimeoutMillis({})).toBeLessThanOrEqual(3_000);
  });

  it('default shutdown deadline is well under a typical orchestrator SIGKILL grace period', () => {
    expect(resolveShutdownDeadlineMillis({})).toBeLessThanOrEqual(25_000);
  });

  it('honors overrides and rejects invalid ones', () => {
    expect(resolveReadyzTimeoutMillis({ READYZ_TIMEOUT_MS: '1500' })).toBe(1500);
    expect(resolveReadyzTimeoutMillis({ READYZ_TIMEOUT_MS: 'nope' })).toBe(3_000);
    expect(resolveShutdownDeadlineMillis({ SHUTDOWN_DEADLINE_MS: '10000' })).toBe(10_000);
  });
});
