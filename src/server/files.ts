/**
 * Attachment bytes on disk (DRV-550).
 *
 * Files live in `AGENT_BOARD_FILES_DIR` (default: a `files/` directory next to the
 * SQLite database, so one persistent volume holds both). Each file is stored under a
 * random name; the original filename is metadata only and never touches the path.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/** Largest accepted upload, in bytes (`AGENT_BOARD_MAX_UPLOAD_BYTES`, default 10 MiB). */
export function maxUploadBytes(): number {
  const raw = Number(process.env['AGENT_BOARD_MAX_UPLOAD_BYTES']);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_BYTES;
}

export function filesDir(): string {
  const override = process.env['AGENT_BOARD_FILES_DIR']?.trim();
  if (override) return override;
  const dbPath =
    process.env['AGENT_BOARD_DB']?.trim() || join(homedir(), '.agent-board', 'board.db');
  return join(dirname(dbPath), 'files');
}

/** Write bytes under a fresh random name; returns that name. */
export function storeFile(bytes: Buffer): string {
  const dir = filesDir();
  mkdirSync(dir, { recursive: true });
  const name = randomBytes(24).toString('hex');
  writeFileSync(join(dir, name), bytes, { flag: 'wx', mode: 0o600 });
  return name;
}

function pathOf(storedName: string): string {
  if (!/^[0-9a-f]{48}$/.test(storedName)) throw new Error('bad stored name');
  return join(filesDir(), storedName);
}

export function readStoredFile(storedName: string): Buffer {
  return readFileSync(pathOf(storedName));
}

export function removeStoredFile(storedName: string): void {
  try {
    rmSync(pathOf(storedName), { force: true });
  } catch (error) {
    console.error('could not remove attachment file', error);
  }
}

/** A filename safe to show and to put in Content-Disposition: no path, no control chars. */
export function cleanFilename(raw: unknown): string {
  const base = String(raw ?? '')
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .trim()
    .slice(0, 200);
  return base || 'file';
}

/** Content types served inline-safe; everything else is downloaded as octet-stream. */
const KNOWN_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/zip',
]);

export function cleanContentType(raw: unknown): string {
  const t = String(raw ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return KNOWN_TYPES.has(t) ? t : 'application/octet-stream';
}
