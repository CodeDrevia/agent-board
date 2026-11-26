/**
 * SQLite storage for the agent bulletin board.
 *
 * The database is intentionally global (machine-wide), not per-repo, so agents
 * working across several repositories at once share a single coordination
 * surface. The file lives at `~/.agent-board/board.db` unless overridden by the
 * `AGENT_BOARD_DB` environment variable.
 *
 * We use Node's built-in `node:sqlite` (`DatabaseSync`) so there is no native
 * addon to compile — the server runs anywhere a modern Node is installed.
 */
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * Load `node:sqlite` at runtime via `require` rather than a static ESM import.
 * The Angular build's route-extraction loader mis-resolves the static
 * `node:sqlite` specifier at build time; deferring to a runtime `require`
 * (only reached on the first real API request) sidesteps that entirely.
 */
function loadDatabaseSync(): typeof DatabaseSyncType {
  const require = createRequire(import.meta.url);
  return (require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType }).DatabaseSync;
}

/** Resolve the on-disk location of the shared board database. */
function resolveDbPath(): string {
  const override = process.env['AGENT_BOARD_DB'];
  if (override && override.trim().length > 0) {
    return override;
  }
  return join(homedir(), '.agent-board', 'board.db');
}

/**
 * Open (creating if needed) the shared board database and ensure the schema
 * exists. WAL mode lets multiple agent processes read/write concurrently with
 * minimal blocking, which matters when several CLIs hit the server at once.
 */
function openDatabase(): DatabaseSyncType {
  const DatabaseSync = loadDatabaseSync();
  const path = resolveDbPath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 4000;');
  migrate(db);
  return db;
}

/** Create tables on first run. Statements are idempotent (IF NOT EXISTS). */
function migrate(db: DatabaseSyncType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL DEFAULT 'other',
      host       TEXT,
      created_at INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      repo        TEXT NOT NULL DEFAULT 'global',
      title       TEXT NOT NULL,
      body        TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'todo',
      claimed_by  TEXT,
      claimed_at  INTEGER,
      tags        TEXT NOT NULL DEFAULT '',
      priority    INTEGER NOT NULL DEFAULT 0,
      created_by  TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_repo   ON tasks(repo);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

    CREATE TABLE IF NOT EXISTS activity (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    INTEGER,
      agent      TEXT,
      repo       TEXT,
      kind       TEXT NOT NULL,
      message    TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at);

    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sender      TEXT NOT NULL,
      recipient   TEXT NOT NULL,
      body        TEXT NOT NULL,
      thread_id   TEXT,
      created_at  INTEGER NOT NULL,
      acked_at    INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_messages_inbox
      ON messages(recipient, acked_at, id);

    -- Retention sweeps select the oldest mail first; without this they would
    -- scan the whole table on every send.
    CREATE INDEX IF NOT EXISTS idx_messages_created
      ON messages(created_at);

    CREATE INDEX IF NOT EXISTS idx_messages_thread
      ON messages(thread_id);

    CREATE TABLE IF NOT EXISTS channels (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      created_by  TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channel_members (
      channel_id  TEXT NOT NULL,
      agent       TEXT NOT NULL,
      joined_at   INTEGER NOT NULL,
      PRIMARY KEY (channel_id, agent),
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_channel_members_agent
      ON channel_members(agent);

    -- Per-agent acknowledgement for channel messages. Direct messages keep
    -- using messages.acked_at; a channel message is one shared row, so each
    -- member needs its own "handled" marker to avoid one ack hiding it for all.
    CREATE TABLE IF NOT EXISTS message_acks (
      message_id  INTEGER NOT NULL,
      agent       TEXT NOT NULL,
      acked_at    INTEGER NOT NULL,
      PRIMARY KEY (message_id, agent),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );
  `);
  migrateBoardV1(db);
  migrateQueues(db);
}

/**
 * Shared-resource queues: one row per named lock, its current holder and lease,
 * and the FIFO waiters (ordered by `id`), unique per agent name and thread_id.
 * Additive only.
 */
function migrateQueues(db: DatabaseSyncType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS queues (
      name              TEXT PRIMARY KEY,
      lease_ms          INTEGER NOT NULL,
      created_by        TEXT,
      created_at        INTEGER NOT NULL,
      holder            TEXT,
      holder_thread_id  TEXT,
      holder_note       TEXT,
      holder_lease_ms   INTEGER,
      held_since        INTEGER,
      lease_expires_at  INTEGER
    );

    CREATE TABLE IF NOT EXISTS queue_waiters (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_name  TEXT NOT NULL,
      agent       TEXT NOT NULL,
      thread_id   TEXT,
      note        TEXT,
      lease_ms    INTEGER,
      joined_at   INTEGER NOT NULL,
      FOREIGN KEY (queue_name) REFERENCES queues(name) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS queue_waiters_member
      ON queue_waiters (queue_name, agent, IFNULL(thread_id, ''));
  `);
}

/** Add `column` to `table` unless an earlier run already did (SQLite has no IF NOT EXISTS). */
function addColumn(db: DatabaseSyncType, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/**
 * Shared task queue (DRV-550): who a task is for, its result, a due date, file
 * attachments, and the web sign-in sessions. Additive only, so an older board.db
 * opens unchanged.
 */
function migrateBoardV1(db: DatabaseSyncType): void {
  addColumn(db, 'tasks', 'target', `TEXT NOT NULL DEFAULT ''`);
  addColumn(db, 'tasks', 'result', `TEXT NOT NULL DEFAULT ''`);
  addColumn(db, 'tasks', 'result_links', `TEXT NOT NULL DEFAULT '[]'`);
  addColumn(db, 'tasks', 'due_date', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_target ON tasks(target);

    CREATE TABLE IF NOT EXISTS attachments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id      INTEGER NOT NULL,
      filename     TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size         INTEGER NOT NULL,
      stored_name  TEXT NOT NULL UNIQUE,
      uploaded_by  TEXT,
      created_at   INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);

    -- Web sign-in sessions: only the SHA-256 of the cookie value is stored.
    CREATE TABLE IF NOT EXISTS web_sessions (
      id_hash       TEXT PRIMARY KEY,
      sub           TEXT NOT NULL,
      username      TEXT NOT NULL,
      csrf          TEXT NOT NULL,
      refresh_token TEXT,
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      checked_at    INTEGER NOT NULL,
      confirmed_at  INTEGER NOT NULL
    );
  `);
}

/**
 * Process-wide singleton handle. The SSR server is a single Node process, so
 * one shared connection (with WAL + busy_timeout) is the simplest correct
 * setup; `DatabaseSync` calls are synchronous and short.
 */
let handle: DatabaseSyncType | undefined;

/** Lazily open and return the shared database connection. */
export function db(): DatabaseSyncType {
  if (!handle) {
    handle = openDatabase();
  }
  return handle;
}

/** Close the process-wide handle, primarily for clean shutdowns and isolated tests. */
export function closeDatabase(): void {
  handle?.close();
  handle = undefined;
}

/** Current epoch milliseconds — the single time source for all writes. */
export function now(): number {
  return Date.now();
}
