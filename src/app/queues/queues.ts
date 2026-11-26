/**
 * Read-only view of the board's lease queues: who holds each one, how long the
 * lease has left, and who is waiting in FIFO order. Data comes from
 * {@link BoardService.queues}, refreshed by the board's polling timer; a local
 * one-second clock drives the lease countdowns between polls.
 */
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  PLATFORM_ID,
  computed,
  inject,
  signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { BoardService } from '../board/board.service';

@Component({
  selector: 'app-queues',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './queues.html',
  styleUrl: './queues.scss',
})
export class Queues {
  protected readonly board = inject(BoardService);

  /** Wall clock, ticking once a second in the browser for the countdowns. */
  protected readonly now = signal(Date.now());

  /** First load still in flight (later polls keep showing the last value). */
  protected readonly loading = computed(
    () => this.board.queues.isLoading() && !this.board.queues.hasValue(),
  );

  protected readonly error = computed(() => {
    const err = this.board.queues.error();
    return err ? 'Could not load queues.' : null;
  });

  protected readonly queues = computed(() =>
    this.board.queues.hasValue() ? this.board.queues.value() : [],
  );

  constructor() {
    if (isPlatformBrowser(inject(PLATFORM_ID))) {
      const timer = setInterval(() => this.now.set(Date.now()), 1000);
      inject(DestroyRef).onDestroy(() => clearInterval(timer));
    }
  }

  /** Remaining lease as `m:ss` / `h:mm:ss`, or `expired`. */
  protected countdown(expiresAt: number): string {
    const left = Math.floor((expiresAt - this.now()) / 1000);
    if (left <= 0) return 'expired';
    return formatDuration(left);
  }

  /** True when under a minute is left, so the countdown can warn. */
  protected expiringSoon(expiresAt: number): boolean {
    return expiresAt - this.now() < 60_000;
  }

  protected lease(ms: number): string {
    return formatDuration(Math.round(ms / 1000));
  }

  protected clock(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  protected ago(ts: number): string {
    const s = Math.max(0, Math.floor((this.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  }
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
