/**
 * Outgoing notifications for task events (DRV-550).
 *
 * Two sinks, both optional and configured from the environment:
 * - generic webhooks (`AGENT_BOARD_WEBHOOK_URLS`, optional HMAC with
 *   `AGENT_BOARD_WEBHOOK_SECRET`);
 * - a Discord channel message through a bot (`AGENT_BOARD_DISCORD_BOT_TOKEN` +
 *   `AGENT_BOARD_DISCORD_CHANNEL_ID`) for new tasks not meant for the orchestrator.
 *
 * Delivery is fire-and-forget: it never throws into, or delays, the request
 * that created the task. URLs and tokens may carry secrets, so logs name only
 * the destination host.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { Task } from './repo';

export type TaskEventName = 'task.created' | 'task.retargeted';

export interface NotifyConfig {
  webhookUrls: string[];
  webhookSecret: string;
  discordToken: string;
  discordChannelId: string;
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
    const jobs: Promise<boolean>[] = [];
    if (cfg.webhookUrls.length > 0) {
      const body = JSON.stringify(buildPayload(event, task, cfg.boardUrl));
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (cfg.webhookSecret) headers['x-board-signature'] = sign(body, cfg.webhookSecret);
      for (const url of cfg.webhookUrls) {
        jobs.push(deliver(url, { headers, body }, `webhook ${hostOf(url)}`, cfg, doFetch, log));
      }
    }
    if (
      event === 'task.created' &&
      cfg.discordToken &&
      cfg.discordChannelId &&
      norm(task.target) !== 'orchestrator'
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

/** Fire-and-forget entry point used by the data layer. */
export function notifyTaskEvent(event: TaskEventName, task: Task): void {
  if (process.env['VITEST'] && !process.env['AGENT_BOARD_NOTIFY_IN_TESTS']) return;
  void dispatch(event, task).catch(() => undefined);
}
