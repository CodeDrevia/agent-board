/**
 * Shared-resource queues: named locks agents take turns on (a browser, a deploy
 * slot, a phone). One holder at a time, on a lease; everyone else waits in FIFO
 * order and is granted the queue as soon as it frees.
 *
 * Every operation runs in one IMMEDIATE transaction that first frees expired
 * leases, so no decision is made on a lease that should already have ended.
 * Grant webhooks go out only after that transaction commits.
 */
import { db, now } from './db';
import { notifyQueueGranted, type QueueGrant } from './notify';

export const DEFAULT_LEASE_MS = 30 * 60_000;
export const MAX_LEASE_MS = 24 * 60 * 60_000;
const MIN_LEASE_MS = 1_000;

export interface QueueHolder {
  agent: string;
  thread_id: string | null;
  note: string | null;
  since: number;
  lease_expires_at: number;
}

export interface QueueWaiter {
  agent: string;
  thread_id: string | null;
  note: string | null;
  /** 1 = next in line. */
  position: number;
  joined_at: number;
}

export interface Queue {
  name: string;
  /** Lease a new holder gets unless their join asked for another. */
  lease_ms: number;
  created_by: string | null;
  created_at: number;
  holder: QueueHolder | null;
  waiters: QueueWaiter[];
}

/** Where one agent stands in a queue. */
export type QueueMembership =
  | { state: 'holding'; lease_expires_at: number }
  | { state: 'waiting'; position: number }
  | { state: 'none' };

export type QueueResult =
  | { ok: true; queue: Queue; you: QueueMembership }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_holder'; queue: Queue; you: QueueMembership };

interface QueueRow {
  name: string;
  lease_ms: number;
  created_by: string | null;
  created_at: number;
  holder: string | null;
  holder_thread_id: string | null;
  holder_note: string | null;
  holder_lease_ms: number | null;
  held_since: number | null;
  lease_expires_at: number | null;
}

interface WaiterRow {
  id: number;
  agent: string;
  thread_id: string | null;
  note: string | null;
  lease_ms: number | null;
  joined_at: number;
}

/** Lower case, spaces to dashes; letters, digits, `.`, `_`, `-`; at most 64 characters. */
export function normaliseQueueName(raw: unknown): string | null {
  const name = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) ? name : null;
}

/**
 * A lease length in ms from a client: a positive integer (or numeric string),
 * clamped to [1 s, 24 h]. `undefined` means "use the default".
 */
export function parseLeaseMs(raw: unknown): number | undefined | 'invalid' {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const ms = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : raw;
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms <= 0) return 'invalid';
  return Math.min(MAX_LEASE_MS, Math.max(MIN_LEASE_MS, ms));
}

function queueRow(name: string): QueueRow | undefined {
  return db().prepare(`SELECT * FROM queues WHERE name = ?`).get(name) as unknown as
    QueueRow | undefined;
}

function waiterRows(name: string): WaiterRow[] {
  return db()
    .prepare(`SELECT * FROM queue_waiters WHERE queue_name = ? ORDER BY id`)
    .all(name) as unknown as WaiterRow[];
}

function view(row: QueueRow): Queue {
  return {
    name: row.name,
    lease_ms: row.lease_ms,
    created_by: row.created_by,
    created_at: row.created_at,
    holder:
      row.holder === null
        ? null
        : {
            agent: row.holder,
            thread_id: row.holder_thread_id,
            note: row.holder_note,
            since: row.held_since ?? row.created_at,
            lease_expires_at: row.lease_expires_at ?? 0,
          },
    waiters: waiterRows(row.name).map((w, i) => ({
      agent: w.agent,
      thread_id: w.thread_id,
      note: w.note,
      position: i + 1,
      joined_at: w.joined_at,
    })),
  };
}

function membershipOf(queue: Queue, agent: string): QueueMembership {
  if (queue.holder?.agent === agent)
    return { state: 'holding', lease_expires_at: queue.holder.lease_expires_at };
  const waiter = queue.waiters.find((w) => w.agent === agent);
  return waiter ? { state: 'waiting', position: waiter.position } : { state: 'none' };
}

function setHolder(
  name: string,
  holder: { agent: string; thread_id: string | null; note: string | null; lease_ms: number },
  at: number,
): number {
  const expires = at + holder.lease_ms;
  db()
    .prepare(
      `UPDATE queues
          SET holder = ?, holder_thread_id = ?, holder_note = ?, holder_lease_ms = ?,
              held_since = ?, lease_expires_at = ?
        WHERE name = ?`,
    )
    .run(holder.agent, holder.thread_id, holder.note, holder.lease_ms, at, expires, name);
  return expires;
}

/** Free the queue and hand it to the first waiter, if any. */
function grantNext(row: QueueRow, at: number, grants: QueueGrant[]): void {
  const next = db()
    .prepare(`SELECT * FROM queue_waiters WHERE queue_name = ? ORDER BY id LIMIT 1`)
    .get(row.name) as unknown as WaiterRow | undefined;
  if (!next) {
    db()
      .prepare(
        `UPDATE queues
            SET holder = NULL, holder_thread_id = NULL, holder_note = NULL,
                holder_lease_ms = NULL, held_since = NULL, lease_expires_at = NULL
          WHERE name = ?`,
      )
      .run(row.name);
    return;
  }
  db().prepare(`DELETE FROM queue_waiters WHERE id = ?`).run(next.id);
  const leaseExpiresAt = setHolder(
    row.name,
    { ...next, lease_ms: next.lease_ms ?? row.lease_ms },
    at,
  );
  grants.push({
    queue: row.name,
    agent: next.agent,
    thread_id: next.thread_id,
    lease_expires_at: leaseExpiresAt,
  });
}

function expireLeases(at: number, grants: QueueGrant[]): number {
  const expired = db()
    .prepare(`SELECT * FROM queues WHERE holder IS NOT NULL AND lease_expires_at <= ?`)
    .all(at) as unknown as QueueRow[];
  for (const row of expired) grantNext(row, at, grants);
  return expired.length;
}

/**
 * Run `fn` in one IMMEDIATE transaction after freeing expired leases, then send
 * the grant webhooks once it has committed.
 */
function transact<T>(fn: (at: number, grants: QueueGrant[], expired: number) => T): T {
  const d = db();
  const grants: QueueGrant[] = [];
  const at = now();
  d.exec('BEGIN IMMEDIATE');
  let out: T;
  try {
    const expired = expireLeases(at, grants);
    out = fn(at, grants, expired);
    d.exec('COMMIT');
  } catch (error) {
    d.exec('ROLLBACK');
    throw error;
  }
  for (const grant of grants) notifyQueueGranted(grant);
  return out;
}

/** Shared shape of the holder/waiter operations: unknown queue → not_found. */
function onQueue(
  name: string,
  agent: string,
  fn: (row: QueueRow, at: number, grants: QueueGrant[]) => 'ok' | 'not_holder',
): QueueResult {
  return transact((at, grants) => {
    const row = queueRow(name);
    if (!row) return { ok: false, reason: 'not_found' };
    const outcome = fn(row, at, grants);
    const queue = view(queueRow(name)!);
    const you = membershipOf(queue, agent);
    return outcome === 'ok'
      ? { ok: true, queue, you }
      : { ok: false, reason: 'not_holder', queue, you };
  });
}

/** Create a queue; idempotent. A `lease_ms` given for an existing queue replaces its default. */
export function createQueue(input: { name: string; lease_ms?: number; created_by?: string }): {
  queue: Queue;
  created: boolean;
} {
  return transact((at) => {
    const created =
      db()
        .prepare(
          `INSERT OR IGNORE INTO queues (name, lease_ms, created_by, created_at) VALUES (?, ?, ?, ?)`,
        )
        .run(input.name, input.lease_ms ?? DEFAULT_LEASE_MS, input.created_by ?? null, at).changes >
      0;
    if (!created && input.lease_ms !== undefined) {
      db().prepare(`UPDATE queues SET lease_ms = ? WHERE name = ?`).run(input.lease_ms, input.name);
    }
    return { queue: view(queueRow(input.name)!), created };
  });
}

export function listQueues(): Queue[] {
  return transact(() =>
    (db().prepare(`SELECT * FROM queues ORDER BY name`).all() as unknown as QueueRow[]).map(view),
  );
}

export function getQueue(name: string): Queue | undefined {
  return transact(() => {
    const row = queueRow(name);
    return row ? view(row) : undefined;
  });
}

/**
 * Take the queue when it is free, otherwise wait at the back of the line.
 * Joining again while holding or waiting changes nothing and reports where you stand.
 */
export function joinQueue(input: {
  name: string;
  agent: string;
  thread_id?: string;
  note?: string;
  lease_ms?: number;
}): QueueResult {
  return onQueue(input.name, input.agent, (row, at) => {
    const known =
      row.holder === input.agent ||
      db()
        .prepare(`SELECT 1 FROM queue_waiters WHERE queue_name = ? AND agent = ?`)
        .get(row.name, input.agent) !== undefined;
    if (known) return 'ok';
    const thread_id = input.thread_id ?? null;
    const note = input.note ?? null;
    if (row.holder === null) {
      setHolder(
        row.name,
        { agent: input.agent, thread_id, note, lease_ms: input.lease_ms ?? row.lease_ms },
        at,
      );
    } else {
      db()
        .prepare(
          `INSERT INTO queue_waiters (queue_name, agent, thread_id, note, lease_ms, joined_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(row.name, input.agent, thread_id, note, input.lease_ms ?? null, at);
    }
    return 'ok';
  });
}

/** Extend the holder's lease from now, by `lease_ms` or the lease they were granted. */
export function renewQueue(name: string, agent: string, leaseMs?: number): QueueResult {
  return onQueue(name, agent, (row, at) => {
    if (row.holder !== agent) return 'not_holder';
    const lease = leaseMs ?? row.holder_lease_ms ?? row.lease_ms;
    db()
      .prepare(`UPDATE queues SET holder_lease_ms = ?, lease_expires_at = ? WHERE name = ?`)
      .run(lease, at + lease, name);
    return 'ok';
  });
}

/** Free the queue (holder only) and grant the next waiter. */
export function releaseQueue(name: string, agent: string): QueueResult {
  return onQueue(name, agent, (row, at, grants) => {
    if (row.holder !== agent) return 'not_holder';
    grantNext(row, at, grants);
    return 'ok';
  });
}

/** Stop waiting; a holder leaving frees the queue like a release. Not in it: no-op. */
export function leaveQueue(name: string, agent: string): QueueResult {
  return onQueue(name, agent, (row, at, grants) => {
    if (row.holder === agent) grantNext(row, at, grants);
    else
      db().prepare(`DELETE FROM queue_waiters WHERE queue_name = ? AND agent = ?`).run(name, agent);
    return 'ok';
  });
}

/**
 * Free every expired lease and grant the next waiters. The server runs this on
 * a timer so a lease ends even when nobody calls the API. Returns how many expired.
 */
export function sweepQueues(): number {
  const due = db()
    .prepare(`SELECT 1 FROM queues WHERE holder IS NOT NULL AND lease_expires_at <= ? LIMIT 1`)
    .get(now());
  if (!due) return 0;
  return transact((_at, _grants, expired) => expired);
}
