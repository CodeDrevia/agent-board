/**
 * The board page: the human-facing view of the shared agent bulletin board.
 *
 * It renders tasks as cards grouped into status columns, shows which agents are
 * online, shows recently completed work, and lets a human (identifying as one of
 * the agents, or as themselves) create, claim, and move tasks. All reads come
 * from {@link BoardService}, which polls so other agents' changes appear live.
 */
import {
  ChangeDetectionStrategy,
  Component,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { BoardService } from './board.service';
import { Chat } from '../chat/chat/chat';
import { SendButton } from '../send-button/send-button';
import { LinkedText } from '../linked-text/linked-text';
import {
  COLUMNS,
  ONLINE_WINDOW_MS,
  type Agent,
  type Attachment,
  type Task,
  type TaskEvent,
  type TaskStatus,
} from './models';

/** localStorage key under which the chosen board identity is remembered. */
const IDENTITY_KEY = 'agent-board.identity';

@Component({
  selector: 'app-board',
  imports: [Chat, SendButton, LinkedText],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './board.html',
  styleUrl: './board.scss',
})
export class Board {
  protected readonly board = inject(BoardService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  protected readonly columns = COLUMNS;

  /** Who the web user is acting as when they claim/create (defaults to human). */
  protected readonly identity = signal<string>('human');

  /** New-task form fields. */
  protected readonly draftTitle = signal('');
  protected readonly draftRepo = signal('');
  protected readonly draftBody = signal('');
  protected readonly draftTags = signal('');
  protected readonly draftPriority = signal(0);
  protected readonly draftTarget = signal('');
  protected readonly draftDue = signal('');

  /** The task whose details panel is open, with its loaded history and files. */
  protected readonly openTaskId = signal<number | null>(null);
  protected readonly history = signal<TaskEvent[]>([]);
  protected readonly files = signal<Attachment[]>([]);
  protected readonly resultDraft = signal('');
  protected readonly linksDraft = signal('');
  protected readonly commentDraft = signal('');

  /** Signed-in name, when the server knows one (web sign-in). */
  protected readonly signedInAs = computed(() => {
    const me = this.board.me.hasValue() ? this.board.me.value() : undefined;
    return me && me.kind === 'web' ? me.name : null;
  });
  protected readonly formOpen = signal(false);
  protected readonly archiveOpen = signal(false);
  protected readonly chatOpen = signal(false);

  protected showBoard(): void {
    this.chatOpen.set(false);
    this.archiveOpen.set(false);
  }

  protected showChat(): void {
    this.chatOpen.set(true);
    this.archiveOpen.set(false);
    this.formOpen.set(false);
  }

  protected showArchive(): void {
    this.chatOpen.set(false);
    this.archiveOpen.set(true);
    this.formOpen.set(false);
  }

  /** Tasks grouped by status, so each column can read its bucket directly. */
  protected readonly grouped = computed(() => {
    const map = new Map<TaskStatus, Task[]>();
    for (const col of COLUMNS) {
      map.set(col.status, []);
    }
    for (const task of this.board.tasks.value()) {
      map.get(task.status)?.push(task);
    }
    return map;
  });

  constructor() {
    if (this.isBrowser) {
      const saved = localStorage.getItem(IDENTITY_KEY);
      if (saved) {
        this.identity.set(saved);
      }
      effect(() => localStorage.setItem(IDENTITY_KEY, this.identity()));
    }
  }

  /** Tasks currently in the given column. */
  protected tasksFor(status: TaskStatus): Task[] {
    return this.grouped().get(status) ?? [];
  }

  /** True if the agent checked in recently enough to count as online. */
  protected isOnline(agent: Agent): boolean {
    return Date.now() - agent.last_seen < ONLINE_WINDOW_MS;
  }

  /** Split a comma/space separated tag string into chips. */
  protected chips(tags: string): string[] {
    return tags
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }

  /** Human-friendly relative time, e.g. "3m ago". */
  protected ago(ts: number | null): string {
    if (!ts) {
      return '';
    }
    const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  /** Set the repo filter (empty string clears it). */
  protected onRepoFilter(value: string): void {
    this.board.repoFilter.set(value ? value : null);
  }

  protected onIdentityInput(event: Event): void {
    this.identity.set((event.target as HTMLInputElement).value);
  }

  protected onRepoFilterChange(event: Event): void {
    this.onRepoFilter((event.target as HTMLSelectElement).value);
  }

  protected onSearchInput(event: Event): void {
    this.board.search.set((event.target as HTMLInputElement).value);
  }

  protected onArchiveSearchInput(event: Event): void {
    this.board.archiveSearch.set((event.target as HTMLInputElement).value);
  }

  protected onDraftInput(field: 'title' | 'repo' | 'tags' | 'body', event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    const target = {
      title: this.draftTitle,
      repo: this.draftRepo,
      tags: this.draftTags,
      body: this.draftBody,
    }[field];
    target.set(value);
  }

  protected onTargetFilterChange(event: Event): void {
    const v = (event.target as HTMLSelectElement).value;
    this.board.targetFilter.set(v === '*' ? null : v);
  }

  protected onTextInput(target: { set(v: string): void }, event: Event): void {
    target.set((event.target as HTMLInputElement | HTMLTextAreaElement).value);
  }

  /** True when a due date is today or past and the task is still open. */
  protected overdue(task: Task): boolean {
    return !!task.due_date && task.due_date <= new Date().toISOString().slice(0, 10);
  }

  protected async toggleDetails(task: Task): Promise<void> {
    if (this.openTaskId() === task.id) {
      this.openTaskId.set(null);
      return;
    }
    this.openTaskId.set(task.id);
    this.resultDraft.set(task.result);
    this.linksDraft.set(task.result_links.join('\n'));
    this.commentDraft.set('');
    await this.loadDetails(task.id);
  }

  private async loadDetails(id: number): Promise<void> {
    try {
      const [history, files] = await Promise.all([
        this.board.history(id),
        this.board.attachments(id),
      ]);
      if (this.openTaskId() === id) {
        this.history.set(history);
        this.files.set(files);
      }
    } catch {
      this.history.set([]);
      this.files.set([]);
    }
  }

  protected async saveResult(task: Task): Promise<void> {
    const links = this.linksDraft()
      .split(/\s+/)
      .map((l) => l.trim())
      .filter(Boolean);
    await this.safely(() => this.board.setResult(task.id, this.resultDraft(), links));
    await this.loadDetails(task.id);
  }

  /** Post the comment draft; rejects on failure so the send button rolls back. */
  protected readonly postComment = async (task: Task): Promise<void> => {
    const message = this.commentDraft().trim();
    if (!message) return;
    await this.board.comment(task.id, message);
    this.commentDraft.set('');
    // The comment is saved; a failed history refresh must not roll the button back.
    await this.loadDetails(task.id).catch(() => undefined);
  };

  private readonly commentActions = new Map<number, () => Promise<void>>();

  /** A stable per-task action for the comment send button. */
  protected commentAction(task: Task): () => Promise<void> {
    let action = this.commentActions.get(task.id);
    if (!action) {
      action = () => this.postComment(task);
      this.commentActions.set(task.id, action);
    }
    return action;
  }

  protected async retarget(task: Task, event: Event): Promise<void> {
    const target = (event.target as HTMLInputElement).value.trim().toLowerCase();
    if (target !== task.target) await this.safely(() => this.board.updateTask(task.id, { target }));
  }

  protected async redate(task: Task, event: Event): Promise<void> {
    const due = (event.target as HTMLInputElement).value || null;
    if (due !== task.due_date)
      await this.safely(() => this.board.updateTask(task.id, { due_date: due }));
  }

  protected async uploadFile(task: Task, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    await this.safely(() => this.board.upload(task.id, file));
    input.value = '';
    await this.loadDetails(task.id);
  }

  protected async deleteFile(task: Task, file: Attachment): Promise<void> {
    if (!this.isBrowser || confirm(`Delete ${file.filename}?`)) {
      await this.safely(() => this.board.removeAttachment(file.id));
      await this.loadDetails(task.id);
    }
  }

  protected size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  protected async logout(): Promise<void> {
    await this.safely(() => this.board.logout());
    if (this.isBrowser) location.href = '/';
  }

  protected onPriorityInput(event: Event): void {
    this.draftPriority.set(Number((event.target as HTMLInputElement).value) || 0);
  }

  /**
   * Submit the new-task form. Rejects on failure so the send button rolls back;
   * the form closes after the "Posted" hold (see {@link closeForm}).
   */
  protected readonly submit = async (): Promise<void> => {
    const title = this.draftTitle().trim();
    if (!title) {
      return;
    }
    await this.board.createTask({
      title,
      repo: this.draftRepo().trim() || 'global',
      body: this.draftBody().trim(),
      tags: this.draftTags().trim(),
      priority: Number(this.draftPriority()) || 0,
      agent: this.identity(),
      target: this.draftTarget().trim().toLowerCase(),
      due_date: this.draftDue() || null,
    });
    this.draftTitle.set('');
    this.draftBody.set('');
    this.draftTags.set('');
    this.draftPriority.set(0);
    this.draftTarget.set('');
    this.draftDue.set('');
  };

  protected closeForm(): void {
    this.formOpen.set(false);
  }

  /** Try to claim a task; surface a message if another agent beat us to it. */
  protected async claim(task: Task): Promise<void> {
    await this.safely(() => this.board.claim(task.id, this.identity()));
  }

  protected async release(task: Task): Promise<void> {
    await this.safely(() => this.board.release(task.id, this.identity()));
  }

  protected async move(task: Task, status: TaskStatus): Promise<void> {
    await this.safely(() => this.board.setStatus(task.id, status, this.identity()));
  }

  protected async remove(task: Task): Promise<void> {
    if (!this.isBrowser || confirm(`Delete task #${task.id}?`)) {
      await this.safely(() => this.board.remove(task.id));
    }
  }

  private async safely(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch {
      // BoardService exposes the actionable error in the page.
    }
  }
}
