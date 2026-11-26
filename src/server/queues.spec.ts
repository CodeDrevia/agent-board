import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

let tempDir: string;
let queues: typeof import('./queues');
let database: ReturnType<typeof import('./db').db>;
let closeDatabase: typeof import('./db').closeDatabase;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'agent-board-queues-'));
  process.env['AGENT_BOARD_DB'] = join(tempDir, 'board.db');
  queues = await import('./queues');
  const dbModule = await import('./db');
  closeDatabase = dbModule.closeDatabase;
  database = dbModule.db();
});

afterAll(() => {
  closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

/** Backdate the holder's lease; returns the expiry it now has. */
function expireLease(name: string): number {
  const at = Date.now() - 1;
  database.prepare(`UPDATE queues SET lease_expires_at = ? WHERE name = ?`).run(at, name);
  return at;
}

describe('shared-resource queues', () => {
  it('grants exactly one holder when many agents join at once over HTTP', async () => {
    const express = (await import('express')).default;
    const { createApiRouter } = await import('./api');
    const app = express();
    app.use((_req, res, next) => {
      res.locals['principal'] = { kind: 'token', sub: 'token', name: 'orchestrator' };
      next();
    });
    app.use('/api', createApiRouter());
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      expect((await post('/queues', { name: 'Zen Browser' })).status).toBe(201);
      expect((await post('/queues', { name: 'zen-browser' })).status).toBe(200);

      const agents = Array.from({ length: 12 }, (_, i) => `agent-${i}`);
      // Every agent joins twice concurrently: the repeat must not add a second entry.
      // node:sqlite is synchronous, so these requests are serialized by the event loop
      // anyway: this checks the join logic, and cannot detect a missing transaction.
      const responses = await Promise.all(
        [...agents, ...agents].map((agent) => post('/queues/zen-browser/join', { agent })),
      );
      expect(responses.every((r) => r.status === 200)).toBe(true);

      const queue = queues.getQueue('zen-browser')!;
      expect(queue.holder).not.toBeNull();
      expect(queue.waiters.map((w) => w.position)).toEqual(
        Array.from({ length: agents.length - 1 }, (_, i) => i + 1),
      );
      const everyone = [queue.holder!.agent, ...queue.waiters.map((w) => w.agent)];
      expect(new Set(everyone)).toEqual(new Set(agents));

      const intruder = queue.waiters[0].agent;
      const refused = await post('/queues/zen-browser/release', { agent: intruder });
      expect(refused.status).toBe(409);
      expect((await refused.json()).you).toEqual({ state: 'waiting', position: 1 });
      expect((await post('/queues/nope/join', { agent: 'x' })).status).toBe(404);
      // A token caller must name itself: falling back to the token's name would make
      // every such caller the same member.
      expect((await post('/queues/zen-browser/join', {})).status).toBe(400);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('serves waiters in FIFO order through release and leave', () => {
    queues.createQueue({ name: 'deploy' });
    expect(queues.joinQueue({ name: 'deploy', agent: 'a' })).toMatchObject({
      ok: true,
      you: { state: 'holding' },
    });
    for (const agent of ['b', 'c', 'd'])
      queues.joinQueue({ name: 'deploy', agent, note: `${agent} PR` });
    expect(queues.joinQueue({ name: 'deploy', agent: 'c' })).toMatchObject({
      you: { state: 'waiting', position: 2 },
    });

    expect(queues.releaseQueue('deploy', { agent: 'b' })).toMatchObject({
      ok: false,
      reason: 'not_holder',
    });
    expect(queues.releaseQueue('deploy', { agent: 'a' })).toMatchObject({
      ok: true,
      you: { state: 'none' },
      queue: { holder: { agent: 'b', note: 'b PR' } },
    });
    expect(queues.leaveQueue('deploy', { agent: 'c' })).toMatchObject({
      ok: true,
      you: { state: 'none' },
    });
    // A holder leaving frees the queue like a release.
    const handed = queues.leaveQueue('deploy', { agent: 'b' });
    expect(handed.ok && handed.queue.holder?.agent).toBe('d');
    expect(handed.ok && handed.queue.waiters).toEqual([]);
    const freed = queues.releaseQueue('deploy', { agent: 'd' });
    expect(freed.ok && freed.queue.holder).toBeNull();
  });

  it('treats the same agent name from another thread as a different member', () => {
    queues.createQueue({ name: 'prod-deploy' });
    const a = { agent: 'orchestrator', thread_id: 'mcp:A' };
    const b = { agent: 'orchestrator', thread_id: 'mcp:B' };
    const bare = { agent: 'orchestrator' };
    expect(queues.joinQueue({ name: 'prod-deploy', ...a })).toMatchObject({
      you: { state: 'holding' },
    });
    expect(queues.joinQueue({ name: 'prod-deploy', ...b })).toMatchObject({
      you: { state: 'waiting', position: 1 },
    });
    expect(queues.joinQueue({ name: 'prod-deploy', ...bare })).toMatchObject({
      you: { state: 'waiting', position: 2 },
    });

    for (const other of [b, bare]) {
      expect(queues.renewQueue('prod-deploy', other)).toMatchObject({ reason: 'not_holder' });
      expect(queues.releaseQueue('prod-deploy', other)).toMatchObject({ reason: 'not_holder' });
    }
    // Leaving as someone else removes only your own place in line.
    queues.leaveQueue('prod-deploy', bare);
    const queue = queues.getQueue('prod-deploy')!;
    expect(queue.holder).toMatchObject(a);
    expect(queue.waiters).toMatchObject([b]);

    expect(queues.releaseQueue('prod-deploy', a)).toMatchObject({
      ok: true,
      queue: { holder: b, waiters: [] },
    });
  });

  it('deletes a queue with its waiters, refusing while held unless forced', () => {
    queues.createQueue({ name: 'doomed' });
    for (const agent of ['a', 'b', 'c']) queues.joinQueue({ name: 'doomed', agent });
    const waitersLeft = () =>
      (
        database
          .prepare(`SELECT COUNT(*) AS n FROM queue_waiters WHERE queue_name = 'doomed'`)
          .get() as { n: number }
      ).n;
    expect(waitersLeft()).toBe(2);

    expect(queues.deleteQueue('doomed')).toMatchObject({
      ok: false,
      reason: 'held',
      queue: { holder: { agent: 'a' } },
    });
    expect(queues.deleteQueue('doomed', true)).toMatchObject({
      ok: true,
      deleted: { holder: { agent: 'a' }, waiters: [{ agent: 'b' }, { agent: 'c' }] },
    });
    expect(queues.getQueue('doomed')).toBeUndefined();
    expect(waitersLeft()).toBe(0);
    expect(queues.deleteQueue('doomed')).toEqual({ ok: false, reason: 'not_found' });

    queues.createQueue({ name: 'free-one' });
    expect(queues.deleteQueue('free-one')).toMatchObject({ ok: true });
  });

  it('hands an expired lease to the next waiter and sends the queue webhooks', () => {
    const sent: Record<string, unknown>[] = [];
    vi.stubEnv('AGENT_BOARD_NOTIFY_IN_TESTS', '1');
    vi.stubEnv('AGENT_BOARD_WEBHOOK_URLS', 'https://hooks.example.com/board');
    // dispatch calls fetch before its first await, so every send is recorded by
    // the time the queue call returns: counts below are exact, with no waiting.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(init.body as string));
        return new Response(null, { status: 204 });
      }),
    );
    const payload = (
      event: string,
      agent: string,
      thread_id: string | null,
      lease_expires_at: number,
    ) => ({
      event,
      delivery_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      queue: { name: 'phone' },
      holder: { agent, thread_id },
      lease_expires_at,
      board_url: 'https://board.bombatomica64.dev',
    });
    try {
      queues.createQueue({ name: 'phone', lease_ms: 60_000 });
      const first = queues.joinQueue({ name: 'phone', agent: 'a', thread_id: 'mcp:thread-a' });
      expect(first.ok && first.queue.holder?.lease_expires_at).toBeGreaterThan(Date.now());
      queues.joinQueue({ name: 'phone', agent: 'b', thread_id: 'mcp:thread-b', lease_ms: 120_000 });
      queues.joinQueue({ name: 'phone', agent: 'c', thread_id: 'mcp:thread-c' });
      expect(sent).toEqual([]); // the immediate grant to `a` is not announced

      expect(queues.sweepQueues()).toBe(0);
      const aExpiredAt = expireLease('phone');
      expect(queues.sweepQueues()).toBe(1);

      const queue = queues.getQueue('phone')!;
      expect(queue.holder).toMatchObject({ agent: 'b', thread_id: 'mcp:thread-b' });
      expect(queue.holder!.lease_expires_at - queue.holder!.since).toBe(120_000);
      expect(queue.waiters.map((w) => w.agent)).toEqual(['c']);
      expect(queues.renewQueue('phone', { agent: 'a', thread_id: 'mcp:thread-a' })).toMatchObject({
        ok: false,
        reason: 'not_holder',
      });
      expect(sent).toEqual([
        payload('queue.expired', 'a', 'mcp:thread-a', aExpiredAt),
        payload('queue.granted', 'b', 'mcp:thread-b', queue.holder!.lease_expires_at),
      ]);

      // Any queue call frees an expired lease too, before deciding.
      const bExpiredAt = expireLease('phone');
      const joined = queues.joinQueue({ name: 'phone', agent: 'd' });
      expect(joined).toMatchObject({
        queue: { holder: { agent: 'c' } },
        you: { state: 'waiting', position: 1 },
      });
      const cExpiresAt = joined.ok && joined.queue.holder!.lease_expires_at;
      expect(sent).toHaveLength(4);
      expect(sent.slice(2)).toEqual([
        payload('queue.expired', 'b', 'mcp:thread-b', bExpiredAt),
        payload('queue.granted', 'c', 'mcp:thread-c', cExpiresAt as number),
      ]);
      expect(new Set(sent.map((p) => p['delivery_id'])).size).toBe(4);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('caps leases at 24 hours and renews from now', () => {
    expect(queues.parseLeaseMs(48 * 60 * 60_000)).toBe(queues.MAX_LEASE_MS);
    expect(queues.parseLeaseMs('0')).toBe('invalid');
    expect(queues.parseLeaseMs(undefined)).toBeUndefined();
    queues.createQueue({ name: 'gpu-pc' });
    const held = queues.joinQueue({ name: 'gpu-pc', agent: 'a' });
    expect(held.ok && held.queue.holder!.lease_expires_at - held.queue.holder!.since).toBe(
      queues.DEFAULT_LEASE_MS,
    );
    const renewed = queues.renewQueue('gpu-pc', { agent: 'a' }, queues.MAX_LEASE_MS);
    expect(renewed.ok && renewed.you).toEqual({
      state: 'holding',
      lease_expires_at: expect.any(Number),
    });
    expect(renewed.ok && renewed.queue.holder!.lease_expires_at).toBeGreaterThanOrEqual(
      Date.now() + queues.MAX_LEASE_MS - 1_000,
    );
  });

  it('refuses a non-holder and a nameless token caller through MCP', async () => {
    const { createMailboxMcpServer } = await import('./mcp');
    const connect = async () => {
      const server = createMailboxMcpServer({
        mode: 'full',
        principal: { kind: 'token', sub: 'token:orchestrator', name: 'orchestrator' },
      });
      const client = new Client({ name: 'queue-test', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return { client, close: () => Promise.all([client.close(), server.close()]) };
    };
    const one = await connect();
    const two = await connect();
    try {
      await one.client.callTool({ name: 'queue_create', arguments: { queue: 'mcp-lock' } });
      const joined = await one.client.callTool({
        name: 'queue_join',
        arguments: { queue: 'mcp-lock', agent: 'alice', thread_id: 'mcp:A' },
      });
      expect(joined.structuredContent).toMatchObject({ you: { state: 'holding' } });

      const sameNameOtherThread = await two.client.callTool({
        name: 'queue_join',
        arguments: { queue: 'mcp-lock', agent: 'alice', thread_id: 'mcp:B' },
      });
      expect(sameNameOtherThread.structuredContent).toMatchObject({
        you: { state: 'waiting', position: 1 },
      });
      const refused = await two.client.callTool({
        name: 'queue_release',
        arguments: { queue: 'mcp-lock', agent: 'alice', thread_id: 'mcp:B' },
      });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({ reason: 'not_holder' });

      // Two clients omitting `agent` would both be the token's name: refuse both.
      for (const { client } of [one, two]) {
        const nameless = await client.callTool({
          name: 'queue_join',
          arguments: { queue: 'mcp-lock' },
        });
        expect(nameless.isError).toBe(true);
        expect(nameless.structuredContent).toMatchObject({ reason: 'agent_required' });
      }

      const held = await two.client.callTool({
        name: 'queue_delete',
        arguments: { queue: 'mcp-lock' },
      });
      expect(held.structuredContent).toMatchObject({ reason: 'held' });
      const forced = await two.client.callTool({
        name: 'queue_delete',
        arguments: { queue: 'mcp-lock', force: true },
      });
      expect(forced.structuredContent).toMatchObject({ deleted: { name: 'mcp-lock' } });
    } finally {
      await one.close();
      await two.close();
    }
  });
});
