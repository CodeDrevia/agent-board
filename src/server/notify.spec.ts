import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  buildPayload,
  buildQueueGrantPayload,
  configFromEnv,
  dispatch,
  dispatchQueueGranted,
  isSelfLoop,
  sign,
  type NotifyConfig,
} from './notify';
import type { Task } from './repo';

const SECRET_URL = 'https://hooks.example.com/in/s3cr3t-token-123';
const TOKEN = 'discord-bot-token-xyz';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 7,
    repo: 'global',
    title: 'Do it',
    body: '',
    status: 'todo',
    claimed_by: null,
    claimed_at: null,
    tags: '',
    priority: 2,
    created_by: 'alessandro',
    created_at: 0,
    updated_at: 0,
    target: ' ChatGPT ',
    result: '',
    result_links: [],
    due_date: '2026-12-01',
    ...over,
  };
}

function cfg(over: Partial<NotifyConfig> = {}): NotifyConfig {
  return {
    webhookUrls: [SECRET_URL],
    webhookSecret: '',
    discordToken: '',
    discordChannelId: '',
    discordSkipTargets: configFromEnv({}).discordSkipTargets,
    boardUrl: 'https://board.bombatomica64.dev',
    timeoutMs: 50,
    retries: 2,
    backoffMs: 1,
    ...over,
  };
}

function okFetch() {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status: 204 }),
  );
}

describe('notify', () => {
  it('builds the documented payload with a normalised target', () => {
    const p = buildPayload('task.created', task(), 'https://board.bombatomica64.dev', 'd-1');
    expect(p).toEqual({
      event: 'task.created',
      delivery_id: 'd-1',
      task: {
        id: 7,
        title: 'Do it',
        target: 'chatgpt',
        created_by: 'alessandro',
        priority: 2,
        due_date: '2026-12-01',
      },
      board_url: 'https://board.bombatomica64.dev',
    });
  });

  it('signs the exact raw body with HMAC-SHA256', async () => {
    const f = okFetch();
    await dispatch(
      'task.created',
      task(),
      cfg({ webhookSecret: 'k' }),
      f as unknown as typeof fetch,
      () => {},
    );
    const init = f.mock.calls[0][1]!;
    const body = init.body as string;
    const expected = 'sha256=' + createHmac('sha256', 'k').update(body).digest('hex');
    expect((init.headers as Record<string, string>)['x-board-signature']).toBe(expected);
    expect(sign(body, 'k')).toBe(expected);
    expect(JSON.parse(body).delivery_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('omits the signature without a secret', async () => {
    const f = okFetch();
    await dispatch('task.created', task(), cfg(), f as unknown as typeof fetch, () => {});
    expect(
      (f.mock.calls[0][1]!.headers as Record<string, string>)['x-board-signature'],
    ).toBeUndefined();
  });

  it('skips self-loops', async () => {
    expect(isSelfLoop({ target: 'Orchestrator ', created_by: 'orchestrator' })).toBe(true);
    expect(isSelfLoop({ target: '', created_by: '' })).toBe(false);
    const f = okFetch();
    await dispatch(
      'task.created',
      task({ target: 'orchestrator', created_by: 'Orchestrator' }),
      cfg(),
      f as unknown as typeof fetch,
      () => {},
    );
    expect(f).not.toHaveBeenCalled();
  });

  it('posts to Discord only for new tasks whose target is not skipped, without mentions or embeds', async () => {
    const c = cfg({ webhookUrls: [], discordToken: TOKEN, discordChannelId: '123' });
    const f = okFetch();
    await dispatch('task.created', task(), c, f as unknown as typeof fetch, () => {});
    expect(String(f.mock.calls[0][0])).toBe('https://discord.com/api/v10/channels/123/messages');
    const body = JSON.parse(f.mock.calls[0][1]!.body as string);
    expect(body).toEqual({
      content: 'New board task #7 for chatgpt: Do it — https://board.bombatomica64.dev/?task=7',
      allowed_mentions: { parse: [] },
      flags: 4,
    });
    f.mockClear();
    for (const target of ['orchestrator', ' Clashboard ', 'brain', 'side']) {
      await dispatch('task.created', task({ target }), c, f as unknown as typeof fetch, () => {});
    }
    await dispatch('task.retargeted', task(), c, f as unknown as typeof fetch, () => {});
    expect(f).not.toHaveBeenCalled();
    await dispatch('task.created', task({ target: '' }), c, f as unknown as typeof fetch, () => {});
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('reads the Discord skip list from the env, replacing the default', () => {
    expect(configFromEnv({}).discordSkipTargets).toEqual([
      'orchestrator',
      'clashboard',
      'brain',
      'side',
    ]);
    expect(
      configFromEnv({ AGENT_BOARD_DISCORD_SKIP_TARGETS: ' ChatGPT, ,lorenzo' }).discordSkipTargets,
    ).toEqual(['chatgpt', 'lorenzo']);
  });

  it('sends queue.granted to the webhooks only, signed, with the documented payload', async () => {
    const grant = {
      queue: 'zen-browser',
      agent: 'claude-1',
      thread_id: 'mcp:t1',
      lease_expires_at: 123,
    };
    expect(buildQueueGrantPayload(grant, 'https://board.bombatomica64.dev', 'd-2')).toEqual({
      event: 'queue.granted',
      delivery_id: 'd-2',
      queue: { name: 'zen-browser' },
      holder: { agent: 'claude-1', thread_id: 'mcp:t1' },
      lease_expires_at: 123,
      board_url: 'https://board.bombatomica64.dev',
    });
    const f = okFetch();
    await dispatchQueueGranted(
      grant,
      cfg({ webhookSecret: 'k', discordToken: TOKEN, discordChannelId: '123' }),
      f as unknown as typeof fetch,
      () => {},
    );
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0][0])).toBe(SECRET_URL);
    const init = f.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>)['x-board-signature']).toBe(
      sign(init.body as string, 'k'),
    );
    expect(JSON.parse(init.body as string).event).toBe('queue.granted');
  });

  it('retries, then gives up, logging only hosts and never secrets', async () => {
    const logs: string[] = [];
    const f = vi.fn(async () => {
      throw new Error(`connect failed ${SECRET_URL} ${TOKEN}`);
    });
    await dispatch(
      'task.created',
      task(),
      cfg({ discordToken: TOKEN, discordChannelId: '123' }),
      f as unknown as typeof fetch,
      (m) => logs.push(m),
    );
    expect(f).toHaveBeenCalledTimes(6); // 2 sinks x (1 + 2 retries)
    const all = logs.join('\n');
    expect(all).toContain('hooks.example.com');
    expect(all).not.toContain('s3cr3t');
    expect(all).not.toContain(TOKEN);
  });

  it('parses the env and drops non-http entries', () => {
    const c = configFromEnv({
      AGENT_BOARD_WEBHOOK_URLS: ` ${SECRET_URL}, ,ftp://x, http://a.test/h`,
    });
    expect(c.webhookUrls).toEqual([SECRET_URL, 'http://a.test/h']);
    expect(c.boardUrl).toBe('https://board.bombatomica64.dev');
  });
});

describe('task creation with failing notifications', () => {
  let tempDir: string;
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('still creates and retargets tasks when delivery throws', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'agent-board-notify-'));
    vi.stubEnv('AGENT_BOARD_DB', join(tempDir, 'board.db'));
    vi.stubEnv('AGENT_BOARD_NOTIFY_IN_TESTS', '1');
    vi.stubEnv('AGENT_BOARD_WEBHOOK_URLS', SECRET_URL);
    const f = vi.fn(() => {
      throw new Error('boom');
    });
    vi.stubGlobal('fetch', f);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repo = await import('./repo');
    const created = repo.createTask({ title: 'x', target: 'chatgpt', created_by: 'alessandro' });
    expect(created.id).toBeGreaterThan(0);
    const moved = repo.updateTask(created.id, { target: 'lorenzo' });
    expect(moved?.target).toBe('lorenzo');
    await vi.waitFor(() => expect(f.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(warn.mock.calls.flat().join('\n')).not.toContain('s3cr3t');
    (await import('./db')).closeDatabase();
  });
});
