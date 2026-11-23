import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

let tempDir: string;
let repo: typeof import('./repo');
let auth: typeof import('./auth');
let files: typeof import('./files');
let mcp: typeof import('./mcp');
let closeDatabase: typeof import('./db').closeDatabase;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'agent-board-v1-'));
  process.env['AGENT_BOARD_DB'] = join(tempDir, 'board.db');
  repo = await import('./repo');
  auth = await import('./auth');
  files = await import('./files');
  mcp = await import('./mcp');
  closeDatabase = (await import('./db')).closeDatabase;
});

afterAll(() => {
  closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('shared queue fields', () => {
  it('stores target, due date and result, and filters by target', () => {
    const a = repo.createTask({ title: 'for chatgpt', target: ' ChatGPT ', due_date: '2026-12-01' });
    repo.createTask({ title: 'for anyone' });
    expect(a.target).toBe('chatgpt');
    expect(a.due_date).toBe('2026-12-01');
    expect(a.result_links).toEqual([]);
    expect(repo.listTasks({ target: 'chatgpt' }).map((t) => t.title)).toEqual(['for chatgpt']);
    expect(repo.listTasks({ target: '' }).map((t) => t.title)).toEqual(['for anyone']);
    expect(repo.listTargets()).toEqual(['chatgpt']);

    const done = repo.setResult(a.id, { result: 'shipped', links: ['https://example.com/pr/1'], agent: 'x' });
    expect(done?.result).toBe('shipped');
    expect(done?.result_links).toEqual(['https://example.com/pr/1']);
    expect(repo.listComments(a.id).some((e) => e.kind === 'result')).toBe(true);
  });

  it('validates due dates and links', () => {
    expect(repo.parseDueDate('2026-02-30')).toBe('invalid');
    expect(repo.parseDueDate('tomorrow')).toBe('invalid');
    expect(repo.parseDueDate('')).toBeNull();
    expect(repo.parseLinks(['javascript:alert(1)'])).toBeNull();
    expect(repo.parseLinks(['https://ok.example/a'])).toEqual(['https://ok.example/a']);
  });

  it('keeps attachments on disk under random names and drops them with the row', () => {
    const t = repo.createTask({ title: 'with file' });
    const stored = files.storeFile(Buffer.from('hello'));
    const att = repo.addAttachment({
      task_id: t.id,
      filename: files.cleanFilename('../../etc/passwd'),
      content_type: files.cleanContentType('text/html'),
      size: 5,
      stored_name: stored,
      uploaded_by: 'x',
    });
    expect(att.filename).toBe('passwd');
    expect(att.content_type).toBe('application/octet-stream');
    expect(files.readStoredFile(stored).toString()).toBe('hello');
    expect(repo.deleteAttachment(att.id)?.stored_name).toBe(stored);
    files.removeStoredFile(stored);
    expect(() => files.readStoredFile(stored)).toThrow();
  });
});

describe('auth rules', () => {
  it('requires the group in a groups list', () => {
    expect(auth.notAllowed({ sub: '6', groups: ['board-users'] }, 'board-users')).toBeNull();
    expect(auth.notAllowed({ sub: '6', groups: ['other'] }, 'board-users')).toMatch(/not in group/);
    expect(auth.notAllowed({ sub: '6' }, 'board-users')).toMatch(/not in group/);
    expect(auth.notAllowed({ sub: '6', groups: 'board-users' } as never, 'board-users')).toMatch(
      /not in group/,
    );
    expect(auth.notAllowed({ groups: ['board-users'] }, 'board-users')).toMatch(/subject/);
  });

  it('only redirects to local paths', () => {
    expect(auth.safeNext('/board?x=1')).toBe('/board?x=1');
    expect(auth.safeNext('//evil.example')).toBe('/');
    expect(auth.safeNext('https://evil.example')).toBe('/');
    expect(auth.safeNext('/\\evil')).toBe('/');
  });

  it('makes signed-in users act as themselves', () => {
    const web = { kind: 'web' as const, sub: '6', name: 'borgo' };
    const token = { kind: 'token' as const, sub: 'token:orchestrator', name: 'orchestrator' };
    expect(auth.actorFor(web, 'someone-else')).toBe('borgo');
    expect(auth.actorFor(token, 'claude-1')).toBe('claude-1');
    expect(auth.actorFor(token, undefined)).toBe('orchestrator');
  });

  it('is fail closed without configuration', () => {
    const c = auth.readConfig();
    expect(c.disabled).toBe(false);
    expect(auth.webProblem(c)).not.toBeNull();
    expect(auth.oauthProblem(c)).not.toBeNull();
  });
});

describe('mcp actor', () => {
  it('records an OAuth user as the actor whatever agent name is passed', async () => {
    const server = mcp.createMailboxMcpServer({
      mode: 'full',
      principal: { kind: 'oauth', sub: '6', name: 'borgo' },
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const res = (await client.callTool({
      name: 'post_task',
      arguments: { title: 'via mcp', target: 'orchestrator', agent: 'impostor' },
    })) as unknown as { structuredContent: { task: { created_by: string; target: string } } };
    expect(res.structuredContent.task.created_by).toBe('borgo');
    expect(res.structuredContent.task.target).toBe('orchestrator');
    await client.close();
    await server.close();
  });
});
