// ---------------------------------------------------------------------------
// B1 — process-role predicates. Pure functions, zero DB/HTTP — see
// processRoles.ts's own header for the architecture these gate in index.ts.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import {
  resolveProcessRole,
  roleExitsAfterMigration,
  roleRunsHealthOnlyApi,
  roleRunsHttpApi,
  roleRunsMigrations,
  roleRunsSse,
  roleRunsWorkerTimers,
  type ProcessRole,
} from '../processRoles';

describe('resolveProcessRole', () => {
  it('defaults to "all" when PROCESS_ROLE is unset', () => {
    expect(resolveProcessRole({})).toBe('all');
  });

  it('accepts each valid role, case-insensitively and trimmed', () => {
    expect(resolveProcessRole({ PROCESS_ROLE: 'api' })).toBe('api');
    expect(resolveProcessRole({ PROCESS_ROLE: 'WORKER' })).toBe('worker');
    expect(resolveProcessRole({ PROCESS_ROLE: '  migrator  ' })).toBe('migrator');
    expect(resolveProcessRole({ PROCESS_ROLE: 'All' })).toBe('all');
  });

  it('falls back to "all" for an unrecognized value rather than throwing', () => {
    expect(resolveProcessRole({ PROCESS_ROLE: 'bogus-role' })).toBe('all');
    expect(resolveProcessRole({ PROCESS_ROLE: '' })).toBe('all');
  });

  it('never reads global process.env when an env object is supplied (no cross-test leakage)', () => {
    const original = process.env.PROCESS_ROLE;
    process.env.PROCESS_ROLE = 'worker';
    try {
      expect(resolveProcessRole({})).toBe('all');
    } finally {
      if (original === undefined) delete process.env.PROCESS_ROLE;
      else process.env.PROCESS_ROLE = original;
    }
  });
});

describe('role predicates — the actual B1 gate: exactly one role class runs the domain timers', () => {
  const ALL_ROLES: ProcessRole[] = ['all', 'api', 'worker', 'migrator'];

  it('roleRunsWorkerTimers is true for exactly {all, worker}', () => {
    const trueFor = ALL_ROLES.filter(roleRunsWorkerTimers);
    expect(trueFor.sort()).toEqual(['all', 'worker']);
  });

  it('two "api"-role replicas both evaluate roleRunsWorkerTimers to false — the literal B1 gate ("zwei API-Replikas starten ohne doppelte Timer")', () => {
    const replicaA = roleRunsWorkerTimers('api');
    const replicaB = roleRunsWorkerTimers('api');
    expect(replicaA).toBe(false);
    expect(replicaB).toBe(false);
    // Neither replica registers a single domain timer, so N api replicas
    // register 0 * N = 0 domain timers between them — no duplication possible.
  });

  it('roleRunsHttpApi is true for exactly {all, api}', () => {
    expect(ALL_ROLES.filter(roleRunsHttpApi).sort()).toEqual(['all', 'api']);
  });

  it('roleRunsHealthOnlyApi is true for exactly {worker}', () => {
    expect(ALL_ROLES.filter(roleRunsHealthOnlyApi)).toEqual(['worker']);
  });

  it('roleRunsSse is true for exactly {all, api} (per-process SSE ownership, not a fleet-wide singleton)', () => {
    expect(ALL_ROLES.filter(roleRunsSse).sort()).toEqual(['all', 'api']);
  });

  it('roleRunsMigrations is true for exactly {all, migrator}', () => {
    expect(ALL_ROLES.filter(roleRunsMigrations).sort()).toEqual(['all', 'migrator']);
  });

  it('roleExitsAfterMigration is true for exactly {migrator}', () => {
    expect(ALL_ROLES.filter(roleExitsAfterMigration)).toEqual(['migrator']);
  });

  it('"all" runs migrations, timers, SSE, and the full HTTP API — reproduces pre-B1 single-container behavior exactly', () => {
    expect(roleRunsMigrations('all')).toBe(true);
    expect(roleRunsWorkerTimers('all')).toBe(true);
    expect(roleRunsSse('all')).toBe(true);
    expect(roleRunsHttpApi('all')).toBe(true);
    expect(roleRunsHealthOnlyApi('all')).toBe(false);
    expect(roleExitsAfterMigration('all')).toBe(false);
  });

  it('every role is HTTP-API-serving XOR health-only-serving XOR neither (migrator) — never both', () => {
    for (const role of ALL_ROLES) {
      const bothFullAndHealthOnly = roleRunsHttpApi(role) && roleRunsHealthOnlyApi(role);
      expect(bothFullAndHealthOnly).toBe(false);
    }
  });
});
