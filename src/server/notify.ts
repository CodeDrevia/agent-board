/**
 * Outgoing notifications for task events (DRV-550).
 *
 * Two sinks, both optional and configured from the environment:
 * - generic webhooks (`AGENT_BOARD_WEBHOOK_URLS`, optional HMAC with
 *   `AGENT_BOARD_WEBHOOK_SECRET`);
 * - a Discord channel message through a bot (`AGENT_BOARD_DISCORD_BOT_TOKEN` +
 *   `AGENT_BOARD_DISCORD_CHANNEL_ID`) for new tasks, except those whose target is
 *   in `AGENT_BOARD_DISCORD_SKIP_TARGETS`.
 *
 * Queue events (`queue.granted`, `queue.expired`, `queue.deleted`) go to the webhooks only.
 *
 * Delivery is fire-and-forget: it never throws into, or delays, the request
 * that created the task. URLs and tokens may carry secrets, so logs name only
 * the destination host.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { Task } from './repo';

export type TaskEventName = 'task.created' | 'task.retargeted';

/** Targets whose new tasks never reach Discord unless the env says otherwise. */
export const DEFAULT_DISCORD_SKIP_TARGETS = 'orchestrator,clashboard,brain,side';

export interface QueueMemberRef {
  agent: string;
  thread_id: string | null;
}

/**
 * `queue.granted`: a waiter now holds the queue (after a release, an expiry or the
 * holder leaving). `queue.expired`: the holder's lease ran out and they no longer
 * hold it. `agent`/`thread_id` are the new holder for a grant, the old one for an expiry.
 * `queue.deleted`: the queue is gone; `holder` lost it (null when it was free) and
 * `waiters` were dropped, in their old order.
 */
export type QueueEvent =
  | {
      event: 'queue.granted' | 'queue.expired';
      queue: string;
      agent: string;
      thread_id: string | null;
      lease_expires_at: number;
    }
  | {
      event: 'queue.deleted';
      queue: string;
      holder: QueueMemberRef | null;
      waiters: QueueMemberRef[];
    };

export interface NotifyConfig {
  webhookUrls: string[];
  webhookSecret: string;
  discordToken: string;
  discordChannelId: string;
  discordSkipTargets: string[];
  boardUrl: string;
  timeoutMs: number;
  retries: number;
  backoffMs: number;
}

type Fetch = typeof fetch;
type Logger = (message: string) => void;

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): NotifyConfig {
  return {
    webhookUrls: (env['AGENT_BOARD_WEBHOOK_URLS'] ?? '')
      .split(',')
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//i.test(u)),
    webhookSecret: env['AGENT_BOARD_WEBHOOK_SECRET'] ?? '',
    discordToken: env['AGENT_BOARD_DISCORD_BOT_TOKEN'] ?? '',
    discordChannelId: (env['AGENT_BOARD_DISCORD_CHANNEL_ID'] ?? '').trim(),
    discordSkipTargets: (env['AGENT_BOARD_DISCORD_SKIP_TARGETS'] ?? DEFAULT_DISCORD_SKIP_TARGETS)
      .split(',')
      .map(norm)
      .filter(Boolean),
    boardUrl: (env['PUBLIC_BASE_URL'] || 'https://board.bombatomica64.dev').replace(/\/+$/, ''),
    timeoutMs: 5000,
    retries: 2,
    backoffMs: 1000,
  };
}

function norm(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/** True when the creator is the target itself (e.g. orchestrator → orchestrator). */
export function isSelfLoop(task: Pick<Task, 'target' | 'created_by'>): boolean {
  const target = norm(task.target);
  return target !== '' && target === norm(task.created_by);
}

export function buildPayload(
  event: TaskEventName,
  task: Task,
  boardUrl: string,
  deliveryId: string = randomUUID(),
) {
  return {
    event,
    delivery_id: deliveryId,
    task: {
      id: task.id,
      title: task.title,
      target: norm(task.target),
      created_by: task.created_by,
      priority: task.priority,
      due_date: task.due_date,
    },
    board_url: boardUrl,
  };
}

export function buildQueueEventPayload(
  e: QueueEvent,
  boardUrl: string,
  deliveryId: string = randomUUID(),
) {
  const base = { event: e.event, delivery_id: deliveryId, queue: { name: e.queue } };
  if (e.event === 'queue.deleted') {
    return { ...base, holder: e.holder, waiters: e.waiters, board_url: boardUrl };
  }
  return {
    ...base,
    holder: { agent: e.agent, thread_id: e.thread_id },
    lease_expires_at: e.lease_expires_at,
    board_url: boardUrl,
  };
}

export function sign(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function discordMessage(task: Task, boardUrl: string): string {
  const target = norm(task.target) || 'anyone';
  return `New board task #${task.id} for ${target}: ${task.title} — ${boardUrl}/?task=${task.id}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid url)';
  }
}

/** POST with timeout and retries; resolves true on 2xx. Never rejects. */
async function deliver(
  url: string,
  init: { headers: Record<string, string>; body: string },
  label: string,
  cfg: NotifyConfig,
  doFetch: Fetch,
  log: Logger,
): Promise<boolean> {
  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, cfg.backoffMs * 2 ** (attempt - 1)));
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: init.headers,
        body: init.body,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      if (res.ok) return true;
      log(`notify: ${label} returned HTTP ${res.status} (attempt ${attempt + 1})`);
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return false;
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      log(`notify: ${label} failed with ${name} (attempt ${attempt + 1})`);
    }
  }
  return false;
}

/** One signed POST per configured webhook URL, all with the same body. */
function webhookJobs(
  payload: unknown,
  cfg: NotifyConfig,
  doFetch: Fetch,
  log: Logger,
): Promise<boolean>[] {
  if (cfg.webhookUrls.length === 0) return [];
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.webhookSecret) headers['x-board-signature'] = sign(body, cfg.webhookSecret);
  return cfg.webhookUrls.map((url) =>
    deliver(url, { headers, body }, `webhook ${hostOf(url)}`, cfg, doFetch, log),
  );
}

/**
 * Send every configured notification for one event. Returns a promise for
 * tests; callers should not await it.
 */
export async function dispatch(
  event: TaskEventName,
  task: Task,
  cfg: NotifyConfig = configFromEnv(),
  doFetch: Fetch = fetch,
  log: Logger = (m) => console.warn(m),
): Promise<void> {
  try {
    if (isSelfLoop(task)) return;
    const jobs = webhookJobs(buildPayload(event, task, cfg.boardUrl), cfg, doFetch, log);
    if (
      event === 'task.created' &&
      cfg.discordToken &&
      cfg.discordChannelId &&
      !cfg.discordSkipTargets.includes(norm(task.target))
    ) {
      const body = JSON.stringify({
        content: discordMessage(task, cfg.boardUrl),
        allowed_mentions: { parse: [] },
        flags: 4, // SUPPRESS_EMBEDS
      });
      jobs.push(
        deliver(
          `https://discord.com/api/v10/channels/${encodeURIComponent(cfg.discordChannelId)}/messages`,
          {
            headers: {
              'content-type': 'application/json',
              authorization: `Bot ${cfg.discordToken}`,
            },
            body,
          },
          'discord',
          cfg,
          doFetch,
          log,
        ),
      );
    }
    await Promise.all(jobs);
  } catch {
    log('notify: unexpected error while dispatching');
  }
}

/** Send one queue event to every webhook. Returns a promise for tests. */
export async function dispatchQueueEvent(
  e: QueueEvent,
  cfg: NotifyConfig = configFromEnv(),
  doFetch: Fetch = fetch,
  log: Logger = (m) => console.warn(m),
): Promise<void> {
  try {
    await Promise.all(webhookJobs(buildQueueEventPayload(e, cfg.boardUrl), cfg, doFetch, log));
  } catch {
    log('notify: unexpected error while dispatching');
  }
}

/** Fire-and-forget entry point used by the queue layer. */
export function notifyQueueEvent(e: QueueEvent): void {
  if (process.env['VITEST'] && !process.env['AGENT_BOARD_NOTIFY_IN_TESTS']) return;
  void dispatchQueueEvent(e).catch(() => undefined);
}

/** Fire-and-forget entry point used by the data layer. */
export function notifyTaskEvent(event: TaskEventName, task: Task): void {
  if (process.env['VITEST'] && !process.env['AGENT_BOARD_NOTIFY_IN_TESTS']) return;
  void dispatch(event, task).catch(() => undefined);
}
