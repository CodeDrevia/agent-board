/**
 * Data-access layer for the bulletin board.
 *
 * All SQL lives here so the HTTP layer (`api.ts`) stays a thin translation of
 * requests to these typed operations. The one piece of real concurrency logic
 * is {@link claimTask}, which performs an atomic conditional UPDATE so two
 * agents can never win the same task.
 */
import { db, now } from './db';
import { notifyTaskEvent } from './notify';

/** Lifecycle states a task can be in. */
export type TaskStatus = 'todo' | 'claimed' | 'in_progress' | 'blocked' | 'done' | 'abandoned';

/** Known agent runtimes, used only for display/filtering. */
export type AgentKind = 'claude' | 'codex' | 'other';

/** A unit of work posted to the board. */
export interface Task {
  id: number;
  repo: string;
  title: string;
  body: string;
  status: TaskStatus;
  claimed_by: string | null;
  claimed_at: number | null;
  tags: string;
  priority: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  /** Who the task is meant for ("orchestrator", "chatgpt", "alessandro"); '' = anyone. */
  target: string;
  /** Outcome written by whoever finished it. */
  result: string;
  /** Links that go with the result (PRs, docs), http(s) only. */
  result_links: string[];
  /** Due date as YYYY-MM-DD, or null. */
  due_date: string | null;
}

/** A file attached to a task; the bytes live on disk under the files directory. */
export interface Attachment {
  id: number;
  task_id: number;
  filename: string;
  content_type: string;
  size: number;
  stored_name: string;
  uploaded_by: string | null;
  created_at: number;
}

/** Turn a raw `tasks` row (result_links as JSON text) into a {@link Task}. */
function hydrate(row: unknown): Task {
  const r = row as Omit<Task, 'result_links'> & { result_links: string | null };
  let links: string[] = [];
  try {
    const parsed = JSON.parse(r.result_links ?? '[]');
    if (Array.isArray(parsed)) links = parsed.filter((x) => typeof x === 'string');
  } catch {
    links = [];
  }
  return { ...r, result_links: links };
}

/** Normalise a target name: trimmed, lower case, at most 64 characters. */
export function normaliseTarget(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase().slice(0, 64);
}

/** Validate a due date: YYYY-MM-DD for a real calendar day, '' / null clears it. */
export function parseDueDate(raw: unknown): string | null | 'invalid' {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return 'invalid';
  const d = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw ? raw : 'invalid';
}

/** Validate result links: at most 20 absolute http(s) URLs. Returns null when any is bad. */
export function parseLinks(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 20) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item.length > 2000) return null;
    try {
      const u = new URL(item.trim());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      out.push(u.toString());
    } catch {
      return null;
    }
  }
  return out;
}

/** An agent process that has checked in with the board. */
export interface Agent {
  id: string;
  kind: AgentKind;
  host: string | null;
  created_at: number;
  last_seen: number;
}

/** A single entry in the append-only activity feed. */
export interface Activity {
  id: number;
  task_id: number | null;
  agent: string | null;
  repo: string | null;
  kind: string;
  message: string;
  created_at: number;
}

export interface MailMessage {
  id: number;
  sender: string;
  recipient: string;
  body: string;
  thread_id: string | null;
  created_at: number;
  acked_at: number | null;
  /**
   * True while the message still awaits acknowledgement. A direct message is
   * unread until its recipient acks it; a channel message is unread while any
   * current member other than the sender has not acked it.
   */
  unread: boolean;
}

/** One conversation thread, summarised for filter UIs. */
export interface MessageThread {
  thread_id: string;
  messages: number;
  unread: number;
  last_at: number;
}

/** Pending messages per recipient token (agent id or `#channel`). */
export interface UnreadCount {
  recipient: string;
  unread: number;
}

export type SendMessageResult =
  { ok: true; message: MailMessage } | { ok: false; reason: 'recipient_not_found' };

/** A group chat channel. Messages sent to it fan out to every member's inbox. */
export interface Channel {
  id: string;
  name: string;
  created_by: string | null;
  created_at: number;
  members: string[];
}

/**
 * Message recipients starting with this prefix address a channel rather than a
 * single agent. The stored channel id is the token without the prefix.
 */
export const CHANNEL_PREFIX = '#';

/** True when a message recipient addresses a channel instead of an agent. */
export function isChannelRecipient(recipient: string): boolean {
  return recipient.startsWith(CHANNEL_PREFIX);
}

/** The message recipient token for a channel id (e.g. `general` -> `#general`). */
export function channelRecipient(id: string): string {
  return `${CHANNEL_PREFIX}${id}`;
}

/** Normalise a free-form channel name into a stable slug id. */
export function channelSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Statuses that leave a task free for another agent to pick up. */
const CLAIMABLE_STATES: TaskStatus[] = ['todo', 'abandoned'];
export const ARCHIVE_AFTER_MS = 15 * 60 * 1000;
const DEFAULT_AGENT_TTL_MS = 24 * 60 * 60 * 1000;

function configuredDuration(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** How long an agent remains addressable after its last heartbeat. */
export const AGENT_TTL_MS = configuredDuration('AGENT_BOARD_AGENT_TTL_MS', DEFAULT_AGENT_TTL_MS);

const DEFAULT_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MESSAGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** How long an acknowledged message is kept before retention removes it. */
export const MESSAGE_TTL_MS = configuredDuration(
  'AGENT_BOARD_MESSAGE_TTL_MS',
  DEFAULT_MESSAGE_TTL_MS,
);

/**
 * Hard ceiling on message age. Mail that is never acknowledged (an agent died,
 * a channel member never came back) would otherwise grow without bound, so it
 * is dropped once it is this old regardless of acknowledgement state.
 */
export const MESSAGE_MAX_AGE_MS = configuredDuration(
  'AGENT_BOARD_MESSAGE_MAX_AGE_MS',
  DEFAULT_MESSAGE_MAX_AGE_MS,
);

/** Rows removed per retention pass, so a sweep never blocks the write path. */
export const MESSAGE_PRUNE_BATCH = 500;

/** Remove identities whose agent processes can no longer be assumed to exist. */
function pruneExpiredAgents(): void {
  db()
    .prepare(`DELETE FROM agents WHERE last_seen < ?`)
    .run(now() - AGENT_TTL_MS);
}

/** Record an entry in the activity feed. Best-effort, never throws to caller. */
function logActivity(entry: {
  task_id?: number | null;
  agent?: string | null;
  repo?: string | null;
  kind: string;
  message?: string;
}): void {
  db()
    .prepare(
      `INSERT INTO activity (task_id, agent, repo, kind, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.task_id ?? null,
      entry.agent ?? null,
      entry.repo ?? null,
      entry.kind,
      entry.message ?? '',
      now(),
    );
}

/** Upsert an agent heartbeat, refreshing `last_seen`. */
export function heartbeat(input: { name: string; kind?: AgentKind; host?: string }): Agent {
  const ts = now();
  db()
    .prepare(
      `INSERT INTO agents (id, kind, host, created_at, last_seen)
       VALUES (@id, @kind, @host, @ts, @ts)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         host = excluded.host,
         last_seen = excluded.last_seen`,
    )
    .run({
      id: input.name,
      kind: input.kind ?? 'other',
      host: input.host ?? null,
      ts,
    });
  return db().prepare(`SELECT * FROM agents WHERE id = ?`).get(input.name) as unknown as Agent;
}

/** List active agents, most-recently-seen first. */
export function listAgents(): Agent[] {
  pruneExpiredAgents();
  return db().prepare(`SELECT * FROM agents ORDER BY last_seen DESC`).all() as unknown as Agent[];
}

/** Options for filtering the task list. */
export interface TaskQuery {
  repo?: string;
  status?: TaskStatus;
  q?: string;
  /** Only tasks for this target; '*' or omitted = all. */
  target?: string;
}

/** List tasks, newest first, optionally filtered by repo/status/search. */
export function listTasks(query: TaskQuery = {}): Task[] {
  const clauses: string[] = [`(status != 'done' OR updated_at >= @archive_cutoff)`];
  const params: Record<string, string | number> = {};
  params['archive_cutoff'] = now() - ARCHIVE_AFTER_MS;
  if (query.repo) {
    clauses.push('repo = @repo');
    params['repo'] = query.repo;
  }
  if (query.status) {
    clauses.push('status = @status');
    params['status'] = query.status;
  }
  if (query.q) {
    clauses.push('(title LIKE @like OR body LIKE @like OR tags LIKE @like)');
    params['like'] = `%${query.q}%`;
  }
  if (query.target !== undefined && query.target !== '*') {
    clauses.push('target = @target');
    params['target'] = normaliseTarget(query.target);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db()
    .prepare(
      `SELECT * FROM tasks ${where}
       ORDER BY priority DESC, created_at DESC`,
    )
    .all(params)
    .map(hydrate);
}

/** Recently completed work shown briefly outside the active workflow lanes. */
export function listRecentlyCompleted(
  query: {
    repo?: string;
    limit?: number;
  } = {},
): Task[] {
  const limit = Math.min(Math.max(query.limit ?? 8, 1), 50);
  const clauses = [`status = 'done'`, `updated_at >= @archive_cutoff`];
  const params: Record<string, string | number> = {
    archive_cutoff: now() - ARCHIVE_AFTER_MS,
    limit,
  };
  if (query.repo) {
    clauses.push('repo = @repo');
    params['repo'] = query.repo;
  }
  return db()
    .prepare(
      `SELECT * FROM tasks WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC LIMIT @limit`,
    )
    .all(params)
    .map(hydrate);
}

/** Search completed work once it has aged out of the operational board. */
export function listArchivedTasks(
  query: {
    repo?: string;
    q?: string;
    limit?: number;
  } = {},
): Task[] {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const clauses = [`status = 'done'`, `updated_at < @archive_cutoff`];
  const params: Record<string, string | number> = {
    archive_cutoff: now() - ARCHIVE_AFTER_MS,
    limit,
  };
  if (query.repo) {
    clauses.push('repo = @repo');
    params['repo'] = query.repo;
  }
  if (query.q) {
    clauses.push(
      '(title LIKE @like OR body LIKE @like OR tags LIKE @like OR created_by LIKE @like)',
    );
    params['like'] = `%${query.q}%`;
  }
  return db()
    .prepare(
      `SELECT * FROM tasks WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC LIMIT @limit`,
    )
    .all(params)
    .map(hydrate);
}

/** Fetch a single task by id, or `undefined` if it does not exist. */
export function getTask(id: number): Task | undefined {
  const row = db().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
  return row ? hydrate(row) : undefined;
}

/** Distinct repo names currently represented on the board. */
export function listRepos(): string[] {
  const rows = db().prepare(`SELECT DISTINCT repo FROM tasks ORDER BY repo`).all() as unknown as {
    repo: string;
  }[];
  return rows.map((r) => r.repo);
}

/** Create a new task in the `todo` state. */
export function createTask(input: {
  repo?: string;
  title: string;
  body?: string;
  tags?: string;
  priority?: number;
  created_by?: string;
  target?: string;
  due_date?: string | null;
}): Task {
  const ts = now();
  const result = db()
    .prepare(
      `INSERT INTO tasks (repo, title, body, status, tags, priority, created_by, created_at, updated_at,
                          target, due_date)
       VALUES (@repo, @title, @body, 'todo', @tags, @priority, @created_by, @ts, @ts,
               @target, @due_date)`,
    )
    .run({
      target: normaliseTarget(input.target),
      due_date: input.due_date ?? null,
      repo: input.repo?.trim() || 'global',
      title: input.title,
      body: input.body ?? '',
      tags: input.tags ?? '',
      priority: input.priority ?? 0,
      created_by: input.created_by ?? null,
      ts,
    });
  const id = Number(result.lastInsertRowid);
  logActivity({
    task_id: id,
    agent: input.created_by,
    repo: input.repo?.trim() || 'global',
    kind: 'created',
    message: input.title,
  });
  const created = getTask(id)!;
  notifyTaskEvent('task.created', created);
  return created;
}

/** Outcome of a claim attempt. */
export type ClaimResult =
  | { ok: true; task: Task }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'conflict'; task: Task };

export type ReleaseResult =
  | { ok: true; task: Task }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'conflict'; task: Task };

export type StatusResult =
  | { ok: true; task: Task }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'conflict'; task: Task }
  | { ok: false; reason: 'invalid_transition'; task: Task };

const STATUS_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  todo: ['abandoned'],
  claimed: ['in_progress', 'abandoned'],
  in_progress: ['blocked', 'done', 'abandoned'],
  blocked: ['in_progress', 'abandoned'],
  done: ['todo'],
  abandoned: ['todo'],
};

const OWNED_STATES: readonly TaskStatus[] = ['claimed', 'in_progress', 'blocked'];

/**
 * Atomically claim a task for `agent`.
 *
 * The UPDATE only matches rows that are still free (todo/abandoned) or already
 * held by the same agent (idempotent re-claim). SQLite executes the statement
 * atomically, so of two concurrent claimers exactly one sees `changes === 1`;
 * the loser gets a `conflict` with the current holder.
 */
export function claimTask(id: number, agent: string): ClaimResult {
  const ts = now();
  const placeholders = CLAIMABLE_STATES.map(() => '?').join(', ');
  const result = db()
    .prepare(
      `UPDATE tasks
         SET status = 'claimed', claimed_by = ?, claimed_at = ?, updated_at = ?
       WHERE id = ?
         AND (status IN (${placeholders}) OR (status = 'claimed' AND claimed_by = ?))`,
    )
    .run(agent, ts, ts, id, ...CLAIMABLE_STATES, agent);

  const task = getTask(id);
  if (!task) {
    return { ok: false, reason: 'not_found' };
  }
  if (result.changes === 0) {
    return { ok: false, reason: 'conflict', task };
  }
  logActivity({ task_id: id, agent, repo: task.repo, kind: 'claimed' });
  return { ok: true, task };
}

/** Release a claim, returning the task to `todo`. */
export function releaseTask(id: number, agent: string): ReleaseResult {
  const ts = now();
  const result = db()
    .prepare(
      `UPDATE tasks
         SET status = 'todo', claimed_by = NULL, claimed_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'claimed' AND claimed_by = ?`,
    )
    .run(ts, id, agent);
  const task = getTask(id);
  if (!task) {
    return { ok: false, reason: 'not_found' };
  }
  if (result.changes === 0) {
    return { ok: false, reason: 'conflict', task };
  }
  logActivity({ task_id: id, agent, repo: task.repo, kind: 'released' });
  return { ok: true, task };
}

/** Change a task's status (e.g. in_progress, blocked, done). */
export function setStatus(
  id: number,
  status: TaskStatus,
  agent?: string,
  message?: string,
): StatusResult {
  const existing = getTask(id);
  if (!existing) {
    return { ok: false, reason: 'not_found' };
  }
  if (!STATUS_TRANSITIONS[existing.status].includes(status)) {
    return { ok: false, reason: 'invalid_transition', task: existing };
  }
  if (OWNED_STATES.includes(existing.status) && (!agent || existing.claimed_by !== agent)) {
    return { ok: false, reason: 'conflict', task: existing };
  }

  const ts = now();
  const clearsClaim = status === 'todo' || status === 'done' || status === 'abandoned';
  db()
    .prepare(
      `UPDATE tasks
          SET status = ?,
              claimed_by = CASE WHEN ? THEN NULL ELSE claimed_by END,
              claimed_at = CASE WHEN ? THEN NULL ELSE claimed_at END,
              updated_at = ?
        WHERE id = ?`,
    )
    .run(status, clearsClaim ? 1 : 0, clearsClaim ? 1 : 0, ts, id);
  const task = getTask(id);
  if (!task) {
    return { ok: false, reason: 'not_found' };
  }
  logActivity({
    task_id: id,
    agent,
    repo: task.repo,
    kind: 'status',
    message: message ? `${status}: ${message}` : status,
  });
  return { ok: true, task };
}

/** Partially update editable fields of a task. */
export function updateTask(
  id: number,
  patch: Partial<
    Pick<Task, 'title' | 'body' | 'tags' | 'priority' | 'repo' | 'target' | 'due_date'>
  >,
): Task | undefined {
  const existing = getTask(id);
  if (!existing) {
    return undefined;
  }
  const ts = now();
  db()
    .prepare(
      `UPDATE tasks
         SET title = @title, body = @body, tags = @tags,
             priority = @priority, repo = @repo, target = @target,
             due_date = @due_date, updated_at = @ts
       WHERE id = @id`,
    )
    .run({
      id,
      target: patch.target !== undefined ? normaliseTarget(patch.target) : existing.target,
      due_date: patch.due_date !== undefined ? patch.due_date : existing.due_date,
      title: patch.title ?? existing.title,
      body: patch.body ?? existing.body,
      tags: patch.tags ?? existing.tags,
      priority: patch.priority ?? existing.priority,
      repo: patch.repo ?? existing.repo,
      ts,
    });
  const updated = getTask(id);
  if (updated && updated.target !== existing.target) notifyTaskEvent('task.retargeted', updated);
  return updated;
}

/** Write a task's result (text + links). Anyone signed in may do it; it is logged. */
export function setResult(
  id: number,
  input: { result: string; links: string[]; agent?: string },
): Task | undefined {
  const existing = getTask(id);
  if (!existing) return undefined;
  db()
    .prepare(`UPDATE tasks SET result = ?, result_links = ?, updated_at = ? WHERE id = ?`)
    .run(input.result, JSON.stringify(input.links), now(), id);
  logActivity({
    task_id: id,
    agent: input.agent,
    repo: existing.repo,
    kind: 'result',
    message: input.result.slice(0, 500),
  });
  return getTask(id);
}

/** Comments posted on one task, oldest first. */
export function listComments(taskId: number): Activity[] {
  return db()
    .prepare(
      `SELECT * FROM activity WHERE task_id = ? AND kind IN ('comment', 'result', 'status', 'attachment')
       ORDER BY created_at ASC, id ASC`,
    )
    .all(taskId) as unknown as Activity[];
}

/** Record an uploaded file (already written to disk as `stored_name`). */
export function addAttachment(input: Omit<Attachment, 'id' | 'created_at'>): Attachment {
  const ts = now();
  const r = db()
    .prepare(
      `INSERT INTO attachments (task_id, filename, content_type, size, stored_name, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.task_id,
      input.filename,
      input.content_type,
      input.size,
      input.stored_name,
      input.uploaded_by ?? null,
      ts,
    );
  const task = getTask(input.task_id);
  logActivity({
    task_id: input.task_id,
    agent: input.uploaded_by,
    repo: task?.repo,
    kind: 'attachment',
    message: input.filename,
  });
  return getAttachment(Number(r.lastInsertRowid))!;
}

export function getAttachment(id: number): Attachment | undefined {
  return db().prepare(`SELECT * FROM attachments WHERE id = ?`).get(id) as unknown as
    Attachment | undefined;
}

export function listAttachments(taskId: number): Attachment[] {
  return db()
    .prepare(`SELECT * FROM attachments WHERE task_id = ? ORDER BY id`)
    .all(taskId) as unknown as Attachment[];
}

/** Stored file names of a task's attachments (to remove from disk with the task). */
export function attachmentFilesOf(taskId: number): string[] {
  return listAttachments(taskId).map((a) => a.stored_name);
}

/** Delete one attachment row; returns it so the caller can remove the file. */
export function deleteAttachment(id: number): Attachment | undefined {
  const existing = getAttachment(id);
  if (!existing) return undefined;
  db().prepare(`DELETE FROM attachments WHERE id = ?`).run(id);
  return existing;
}

/** Distinct non-empty targets, for filter UIs. */
export function listTargets(): string[] {
  return (
    db()
      .prepare(`SELECT DISTINCT target FROM tasks WHERE target != '' ORDER BY target`)
      .all() as unknown as { target: string }[]
  ).map((r) => r.target);
}

/** Delete a task and its activity (via ON DELETE CASCADE). */
export function deleteTask(id: number): boolean {
  const result = db().prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
  return result.changes > 0;
}

/** Post a free-form comment against a task. */
export function commentTask(id: number, agent: string, message: string): boolean {
  const task = getTask(id);
  if (!task) {
    return false;
  }
  logActivity({
    task_id: id,
    agent,
    repo: task.repo,
    kind: 'comment',
    message,
  });
  return true;
}

/**
 * Record a free-form activity note that isn't tied to a task lifecycle action.
 * Used by agent hooks (e.g. Claude Code's UserPromptSubmit) to report presence
 * and what they're currently being asked to work on.
 */
export function recordNote(input: {
  agent?: string;
  repo?: string;
  kind?: string;
  message: string;
}): void {
  logActivity({
    agent: input.agent ?? null,
    repo: input.repo ?? null,
    kind: input.kind ?? 'note',
    message: input.message,
  });
}

/** Read the activity feed, newest first. */
export function listActivity(query: { repo?: string; limit?: number } = {}): Activity[] {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  if (query.repo) {
    return db()
      .prepare(`SELECT * FROM activity WHERE repo = ? ORDER BY created_at DESC LIMIT ?`)
      .all(query.repo, limit) as unknown as Activity[];
  }
  return db()
    .prepare(`SELECT * FROM activity ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as unknown as Activity[];
}

/**
 * SQL expression (over an aliased `messages m`) that flags a message as still
 * awaiting acknowledgement. Direct mail is unread until `acked_at` is set; a
 * channel message is unread while any current member other than the sender has
 * no row in `message_acks`. The `'#'` literal mirrors {@link CHANNEL_PREFIX}.
 */
const UNREAD_EXPR = `CASE WHEN m.recipient LIKE '#%' THEN
  EXISTS (
    SELECT 1 FROM channel_members cm
    WHERE cm.channel_id = substr(m.recipient, 2)
      AND cm.agent <> m.sender
      AND NOT EXISTS (
        SELECT 1 FROM message_acks a WHERE a.message_id = m.id AND a.agent = cm.agent
      )
  )
ELSE m.acked_at IS NULL END`;

const MESSAGE_SELECT = `SELECT m.*, (${UNREAD_EXPR}) AS unread FROM messages m`;

/** Turn a raw message row into the API shape, normalising `unread` to boolean. */
function toMessage(row: unknown): MailMessage {
  const record = row as MailMessage & { unread: number | boolean };
  return { ...record, unread: Boolean(record.unread) };
}

/** Fetch one message with its unread flag, or `undefined` if it is gone. */
function getMessage(id: number): MailMessage | undefined {
  const row = db().prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id);
  return row ? toMessage(row) : undefined;
}

/**
 * Delete mail that has outlived the retention policy: acknowledged messages
 * older than {@link MESSAGE_TTL_MS}, plus anything older than
 * {@link MESSAGE_MAX_AGE_MS} whether acknowledged or not. Each pass is bounded
 * to `limit` rows so retention never turns into a long-running write. Per-agent
 * acknowledgements cascade with the message. Returns the number of rows removed.
 */
export function pruneMessages(options: { limit?: number } = {}): number {
  const limit = Math.min(Math.max(options.limit ?? MESSAGE_PRUNE_BATCH, 1), 5_000);
  const ts = now();
  const result = db()
    .prepare(
      `DELETE FROM messages WHERE id IN (
         SELECT m.id FROM messages m
         WHERE m.created_at < @max_age_cutoff
            OR (m.created_at < @ttl_cutoff AND (${UNREAD_EXPR}) = 0)
         ORDER BY m.id ASC
         LIMIT @limit
       )`,
    )
    .run({
      ttl_cutoff: ts - MESSAGE_TTL_MS,
      max_age_cutoff: ts - MESSAGE_MAX_AGE_MS,
      limit,
    });
  return Number(result.changes);
}

/** Store a message for an active agent. Delivery is pull-based through its inbox. */
export function sendMessage(input: {
  sender: string;
  recipient: string;
  body: string;
  thread_id?: string;
}): SendMessageResult {
  pruneExpiredAgents();
  // Retention runs opportunistically on the write path; it is bounded, so the
  // cost per send stays flat no matter how much old mail has accumulated.
  pruneMessages();
  const exists = isChannelRecipient(input.recipient)
    ? db()
        .prepare(`SELECT 1 FROM channels WHERE id = ?`)
        .get(input.recipient.slice(CHANNEL_PREFIX.length))
    : db().prepare(`SELECT 1 FROM agents WHERE id = ?`).get(input.recipient);
  if (!exists) {
    return { ok: false, reason: 'recipient_not_found' };
  }
  const result = db()
    .prepare(
      `INSERT INTO messages (sender, recipient, body, thread_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.sender, input.recipient, input.body, input.thread_id?.trim() || null, now());
  return { ok: true, message: getMessage(Number(result.lastInsertRowid))! };
}

/** Filters for the shared transcript. All of them combine with AND. */
export interface MessageQuery {
  after_id?: number;
  limit?: number;
  /** Free-text match across body, sender, recipient, and thread. */
  q?: string;
  /** Exact thread id, so one conversation can be followed on its own. */
  thread_id?: string;
  /** Only messages this agent sent or received (channel token counts too). */
  agent?: string;
  /** Only messages still awaiting acknowledgement. */
  unread_only?: boolean;
}

/**
 * Read the shared message transcript in chronological order, newest `limit`
 * messages first selected then re-sorted ascending so cursors advance naturally.
 */
export function listMessages(input: MessageQuery = {}): MailMessage[] {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 200);
  const clauses = ['m.id > @after_id'];
  const params: Record<string, string | number> = {
    after_id: input.after_id ?? 0,
    limit,
  };
  const q = input.q?.trim();
  if (q) {
    clauses.push(
      `(m.body LIKE @like OR m.sender LIKE @like OR m.recipient LIKE @like
        OR IFNULL(m.thread_id, '') LIKE @like)`,
    );
    params['like'] = `%${q}%`;
  }
  const threadId = input.thread_id?.trim();
  if (threadId) {
    clauses.push('m.thread_id = @thread_id');
    params['thread_id'] = threadId;
  }
  const agent = input.agent?.trim();
  if (agent) {
    clauses.push('(m.sender = @agent OR m.recipient = @agent)');
    params['agent'] = agent;
  }
  if (input.unread_only) {
    clauses.push(`(${UNREAD_EXPR}) = 1`);
  }
  return (
    db()
      .prepare(
        `SELECT * FROM (
           ${MESSAGE_SELECT}
           WHERE ${clauses.join(' AND ')}
           ORDER BY m.id DESC
           LIMIT @limit
         ) ORDER BY id ASC`,
      )
      .all(params) as unknown[]
  ).map(toMessage);
}

/** Summarise conversation threads, most recently active first. */
export function listThreads(input: { limit?: number } = {}): MessageThread[] {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  return db()
    .prepare(
      `SELECT thread_id,
              COUNT(*) AS messages,
              SUM(unread) AS unread,
              MAX(created_at) AS last_at
         FROM (
           SELECT m.thread_id AS thread_id,
                  m.created_at AS created_at,
                  (${UNREAD_EXPR}) AS unread
             FROM messages m
            WHERE m.thread_id IS NOT NULL
         )
        GROUP BY thread_id
        ORDER BY last_at DESC
        LIMIT @limit`,
    )
    .all({ limit }) as unknown as MessageThread[];
}

/**
 * Pending message counts per recipient token, for unread badges in the UI.
 * Recipients with nothing pending are omitted.
 */
export function unreadCounts(): UnreadCount[] {
  return db()
    .prepare(
      `SELECT recipient, COUNT(*) AS unread FROM (
         SELECT m.recipient AS recipient, (${UNREAD_EXPR}) AS unread FROM messages m
       )
       WHERE unread = 1
       GROUP BY recipient
       ORDER BY unread DESC, recipient ASC`,
    )
    .all() as unknown as UnreadCount[];
}

/** Read an agent inbox in ascending order so cursors advance naturally. */
export function readInbox(input: {
  agent: string;
  after_id?: number;
  limit?: number;
  include_acknowledged?: boolean;
}): MailMessage[] {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  // Inbox = direct messages to the agent, plus messages to any channel it is a
  // member of (excluding its own). Direct messages track "handled" via
  // acked_at; channel messages are shared rows, so per-agent acks live in
  // message_acks. The '#' literal mirrors CHANNEL_PREFIX.
  return (
    db()
      .prepare(
        `${MESSAGE_SELECT}
       WHERE m.id > @after_id
         AND (
           m.recipient = @agent
           OR (
             m.sender != @agent
             AND m.recipient IN (
               SELECT '#' || channel_id FROM channel_members WHERE agent = @agent
             )
           )
         )
         AND (
           @include_acknowledged = 1
           OR (m.recipient = @agent AND m.acked_at IS NULL)
           OR (
             m.recipient != @agent
             AND NOT EXISTS (
               SELECT 1 FROM message_acks a
               WHERE a.message_id = m.id AND a.agent = @agent
             )
           )
         )
       ORDER BY m.id ASC
       LIMIT @limit`,
      )
      .all({
        agent: input.agent,
        after_id: input.after_id ?? 0,
        include_acknowledged: input.include_acknowledged ? 1 : 0,
        limit,
      }) as unknown[]
  ).map(toMessage);
}

/** How many messages are still pending in one agent's inbox. */
export function countInbox(agent: string): number {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS pending FROM messages m
        WHERE (
          m.recipient = @agent
          OR (
            m.sender != @agent
            AND m.recipient IN (
              SELECT '#' || channel_id FROM channel_members WHERE agent = @agent
            )
          )
        )
        AND (
          (m.recipient = @agent AND m.acked_at IS NULL)
          OR (
            m.recipient != @agent
            AND NOT EXISTS (
              SELECT 1 FROM message_acks a WHERE a.message_id = m.id AND a.agent = @agent
            )
          )
        )`,
    )
    .get({ agent }) as unknown as { pending: number };
  return row.pending;
}

/**
 * Acknowledge one message. For a direct message only its recipient may ack, via
 * `messages.acked_at`. For a channel message any member may ack, recorded
 * per-agent in `message_acks` so one member's ack does not hide it for others.
 * Returns the message on success, or `undefined` if the agent may not ack it.
 */
export function acknowledgeMessage(id: number, agent: string): MailMessage | undefined {
  const message = getMessage(id);
  if (!message) return undefined;

  if (isChannelRecipient(message.recipient)) {
    const channelId = message.recipient.slice(CHANNEL_PREFIX.length);
    const member = db()
      .prepare(`SELECT 1 FROM channel_members WHERE channel_id = ? AND agent = ?`)
      .get(channelId, agent);
    if (!member) return undefined;
    db()
      .prepare(`INSERT OR IGNORE INTO message_acks (message_id, agent, acked_at) VALUES (?, ?, ?)`)
      .run(id, agent, now());
    return getMessage(id);
  }

  if (message.recipient !== agent) return undefined;
  db().prepare(`UPDATE messages SET acked_at = COALESCE(acked_at, ?) WHERE id = ?`).run(now(), id);
  return getMessage(id);
}

// --- Channels ---------------------------------------------------------------

/** The members of one channel, oldest join first. */
function channelMembers(channelId: string): string[] {
  return (
    db()
      .prepare(`SELECT agent FROM channel_members WHERE channel_id = ? ORDER BY joined_at ASC`)
      .all(channelId) as unknown as { agent: string }[]
  ).map((row) => row.agent);
}

/** List every channel with its current membership, newest first. */
export function listChannels(): Channel[] {
  const rows = db()
    .prepare(`SELECT * FROM channels ORDER BY created_at DESC`)
    .all() as unknown as Omit<Channel, 'members'>[];
  return rows.map((row) => ({ ...row, members: channelMembers(row.id) }));
}

/** Fetch a single channel by id, or `undefined` if it does not exist. */
export function getChannel(id: string): Channel | undefined {
  const row = db().prepare(`SELECT * FROM channels WHERE id = ?`).get(id) as unknown as
    Omit<Channel, 'members'> | undefined;
  return row ? { ...row, members: channelMembers(row.id) } : undefined;
}

export type CreateChannelResult =
  { ok: true; channel: Channel } | { ok: false; reason: 'invalid_name' | 'already_exists' };

/**
 * Create a channel from a display name (slugified into its id) and seed it with
 * an initial member list. The creator, if given, is always a member.
 */
export function createChannel(input: {
  name: string;
  created_by?: string;
  members?: string[];
}): CreateChannelResult {
  const name = input.name.trim();
  const id = channelSlug(name);
  if (!id) return { ok: false, reason: 'invalid_name' };
  if (db().prepare(`SELECT 1 FROM channels WHERE id = ?`).get(id)) {
    return { ok: false, reason: 'already_exists' };
  }
  const ts = now();
  db()
    .prepare(`INSERT INTO channels (id, name, created_by, created_at) VALUES (?, ?, ?, ?)`)
    .run(id, name, input.created_by ?? null, ts);
  const seed = new Set([...(input.members ?? []), ...(input.created_by ? [input.created_by] : [])]);
  const insertMember = db().prepare(
    `INSERT OR IGNORE INTO channel_members (channel_id, agent, joined_at) VALUES (?, ?, ?)`,
  );
  for (const agent of seed) {
    if (agent.trim()) insertMember.run(id, agent.trim(), ts);
  }
  return { ok: true, channel: getChannel(id) as Channel };
}

/** Add an agent to a channel. Returns the channel, or `undefined` if unknown. */
export function joinChannel(id: string, agent: string): Channel | undefined {
  if (!db().prepare(`SELECT 1 FROM channels WHERE id = ?`).get(id)) return undefined;
  db()
    .prepare(
      `INSERT OR IGNORE INTO channel_members (channel_id, agent, joined_at) VALUES (?, ?, ?)`,
    )
    .run(id, agent, now());
  return getChannel(id);
}

/** Remove an agent from a channel. Returns the channel, or `undefined` if unknown. */
export function leaveChannel(id: string, agent: string): Channel | undefined {
  if (!db().prepare(`SELECT 1 FROM channels WHERE id = ?`).get(id)) return undefined;
  db().prepare(`DELETE FROM channel_members WHERE channel_id = ? AND agent = ?`).run(id, agent);
  return getChannel(id);
}

/**
 * Priority scale: higher sorts first, 0 is the default. Named levels map to
 * low=-1, normal=0, high=1, urgent=2; any integer is also accepted.
 */
export const PRIORITY_LEVELS = { low: -1, normal: 0, high: 1, urgent: 2 } as const;

/** Parse a priority given as an integer, a numeric string, or a named level. */
export function parsePriority(value: unknown): number | undefined | 'invalid' {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return Number.isInteger(value) ? value : 'invalid';
  if (typeof value !== 'string') return 'invalid';
  const key = value.trim().toLowerCase();
  if (key in PRIORITY_LEVELS) return PRIORITY_LEVELS[key as keyof typeof PRIORITY_LEVELS];
  return /^-?\d+$/.test(key) ? Number(key) : 'invalid';
}
