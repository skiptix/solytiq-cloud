// ---------------------------------------------------------------------------
// B3 (Phase 2) — a stable per-process identity for lease ownership.
//
// Computed once at module load (process lifetime), not per-call — every
// lease this process claims (schedule-trigger automations, embedding_queue
// rows, …) is stamped with the SAME owner id, so an operator can see, from
// the data alone, which live process currently holds a given lease.
// ---------------------------------------------------------------------------

import crypto from 'crypto';

export const WORKER_ID = `worker_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
