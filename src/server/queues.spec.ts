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

function expireLease(name: string): void {
  database
    .prepare(`UPDATE queues SET lease_expires_at = ? WHERE name = ?`)
    .run(Date.now() - 1, name);
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

    expect(queues.releaseQueue('deploy', 'b')).toMatchObject({ ok: false, reason: 'not_holder' });
    expect(queues.releaseQueue('deploy', 'a')).toMatchObject({
      ok: true,
      you: { state: 'none' },
      queue: { holder: { agent: 'b', note: 'b PR' } },
    });
    expect(queues.leaveQueue('deploy', 'c')).toMatchObject({ ok: true, you: { state: 'none' } });
    // A holder leaving frees the queue like a release.
    const handed = queues.leaveQueue('deploy', 'b');
    expect(handed.ok && handed.queue.holder?.agent).toBe('d');
    expect(handed.ok && handed.queue.waiters).toEqual([]);
    const freed = queues.releaseQueue('deploy', 'd');
    expect(freed.ok && freed.queue.holder).toBeNull();
  });

  it('hands an expired lease to the next waiter and sends the grant webhook', async () => {
    const sent: unknown[] = [];
    vi.stubEnv('AGENT_BOARD_NOTIFY_IN_TESTS', '1');
    vi.stubEnv('AGENT_BOARD_WEBHOOK_URLS', 'https://hooks.example.com/board');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(init.body as string));
        return new Response(null, { status: 204 });
      }),
    );
    try {
      queues.createQueue({ name: 'phone', lease_ms: 60_000 });
      const first = queues.joinQueue({ name: 'phone', agent: 'a' });
      expect(first.ok && first.queue.holder?.lease_expires_at).toBeGreaterThan(Date.now());
      queues.joinQueue({ name: 'phone', agent: 'b', thread_id: 'mcp:thread-b', lease_ms: 120_000 });
      queues.joinQueue({ name: 'phone', agent: 'c' });
      expect(sent).toEqual([]); // the immediate grant to `a` is not announced

      expect(queues.sweepQueues()).toBe(0);
      expireLease('phone');
      expect(queues.sweepQueues()).toBe(1);

      const queue = queues.getQueue('phone')!;
      expect(queue.holder).toMatchObject({ agent: 'b', thread_id: 'mcp:thread-b' });
      expect(queue.holder!.lease_expires_at - queue.holder!.since).toBe(120_000);
      expect(queue.waiters.map((w) => w.agent)).toEqual(['c']);
      expect(queues.renewQueue('phone', 'a')).toMatchObject({ ok: false, reason: 'not_holder' });

      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0]).toEqual({
        event: 'queue.granted',
        delivery_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        queue: { name: 'phone' },
        holder: { agent: 'b', thread_id: 'mcp:thread-b' },
        lease_expires_at: queue.holder!.lease_expires_at,
        board_url: 'https://board.bombatomica64.dev',
      });

      // Any queue call frees an expired lease too, before deciding.
      expireLease('phone');
      expect(queues.joinQueue({ name: 'phone', agent: 'd' })).toMatchObject({
        queue: { holder: { agent: 'c' } },
        you: { state: 'waiting', position: 1 },
      });
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
    const renewed = queues.renewQueue('gpu-pc', 'a', queues.MAX_LEASE_MS);
    expect(renewed.ok && renewed.you).toEqual({
      state: 'holding',
      lease_expires_at: expect.any(Number),
    });
    expect(renewed.ok && renewed.queue.holder!.lease_expires_at).toBeGreaterThanOrEqual(
      Date.now() + queues.MAX_LEASE_MS - 1_000,
    );
  });

  it('refuses a non-holder release through MCP as a tool error', async () => {
    const { createMailboxMcpServer } = await import('./mcp');
    const server = createMailboxMcpServer({ mode: 'full' });
    const client = new Client({ name: 'queue-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    await client.callTool({ name: 'queue_create', arguments: { queue: 'mcp-lock' } });
    const joined = await client.callTool({
      name: 'queue_join',
      arguments: { queue: 'mcp-lock', agent: 'alice' },
    });
    const refused = await client.callTool({
      name: 'queue_release',
      arguments: { queue: 'mcp-lock', agent: 'bob' },
    });

    expect(joined.structuredContent).toMatchObject({ you: { state: 'holding' } });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ reason: 'not_holder' });

    await client.close();
    await server.close();
  });
});
