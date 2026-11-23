/**
 * Paper-plane send button (ported from microix-lab `mx-send-button`).
 *
 * Click, Enter or Space: the plane winds up and flies out top-right while
 * `action()` runs; the animation waits for the real request ("waitUntil"), then
 * the label rolls to `doneLabel`. A rejected action rolls back to idle and
 * announces the failure. WAAPI on transform/opacity only; reduced motion makes
 * movement instant and keeps only short fades. Every state change is announced
 * through a polite live region.
 */
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

export type SendState = 'idle' | 'sending' | 'sent';

const EASE_OUT = 'cubic-bezier(.22,1,.36,1)';
const EASE_IN = 'cubic-bezier(.55,0,.75,.05)';

/** True when the OS asks for reduced motion (or the page forces it with data-motion="reduce"). */
function reducedMotion(): boolean {
  if (typeof window === 'undefined') return true;
  return (
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true ||
    document.documentElement.dataset['motion'] === 'reduce'
  );
}

/** Element.animate that resolves at once without WAAPI or under reduced motion; never throws on cancel. */
function animate(
  el: HTMLElement,
  frames: Keyframe[],
  duration: number,
  easing: string,
): Promise<void> {
  if (typeof el.animate !== 'function') return Promise.resolve();
  const a = el.animate(frames, {
    duration: reducedMotion() ? 0 : duration,
    easing,
    fill: 'forwards',
  });
  return a.finished.then(
    () => undefined,
    () => undefined,
  );
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

@Component({
  selector: 'app-send-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.data-state]': 'state()' },
  template: `
    <button
      #btn
      class="send"
      [class.primary]="variant() === 'primary'"
      [type]="type()"
      [disabled]="disabled() && state() === 'idle'"
      [attr.aria-disabled]="state() !== 'idle' ? 'true' : null"
      (click)="run()"
    >
      <span class="plane" #plane aria-hidden="true">
        <svg viewBox="0 0 24 24" width="14" height="14" focusable="false">
          <path
            d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
        </svg>
      </span>
      <span class="labels">
        <span class="a" #a [attr.aria-hidden]="state() === 'sent' ? 'true' : null">{{
          label()
        }}</span>
        <span class="b" #b [attr.aria-hidden]="state() === 'sent' ? null : 'true'">{{
          doneLabel()
        }}</span>
      </span>
    </button>
    <span class="sr" role="status" aria-live="polite">{{ announcement() }}</span>
  `,
  styleUrl: './send-button.scss',
})
export class SendButton {
  readonly label = input('Send');
  readonly doneLabel = input('Sent');
  readonly type = input<'button' | 'submit'>('button');
  readonly variant = input<'primary' | 'default'>('primary');
  readonly disabled = input(false);
  /** How long "Sent" stays readable before the button resets (not shortened by reduced motion). */
  readonly resetAfter = input(1400);
  /** The real request. The plane stays in flight until it settles; a rejection rolls back. */
  readonly action = input.required<() => Promise<unknown>>();

  /** Fires once the "Sent" hold is over and the button is idle again. */
  readonly sent = output<void>();
  /** Fires when the action rejected and the button rolled back. */
  readonly failed = output<unknown>();

  protected readonly state = signal<SendState>('idle');
  protected readonly announcement = signal('');

  private readonly plane = viewChild.required<ElementRef<HTMLElement>>('plane');
  private readonly labelA = viewChild.required<ElementRef<HTMLElement>>('a');
  private readonly labelB = viewChild.required<ElementRef<HTMLElement>>('b');

  /** Current state, for tests and parents. */
  get currentState(): SendState {
    return this.state();
  }

  private say(message: string): void {
    // Clear first so repeating the same text is still announced.
    this.announcement.set('');
    queueMicrotask(() => this.announcement.set(message));
  }

  async run(): Promise<void> {
    if (this.state() !== 'idle' || this.disabled()) return;
    this.state.set('sending');
    this.say('Sending');
    const plane = this.plane().nativeElement;
    const flight = animate(
      plane,
      [
        { transform: 'translate(0,0) rotate(0)', opacity: 1 },
        { transform: 'translate(-4px,3px) rotate(-8deg)', opacity: 1, offset: 0.25 },
        { transform: 'translate(56px,-36px) rotate(12deg) scale(.6)', opacity: 0 },
      ],
      650,
      EASE_IN,
    );
    let request: Promise<unknown>;
    try {
      request = Promise.resolve(this.action()());
    } catch (error) {
      request = Promise.reject(error);
    }
    try {
      await Promise.all([flight, request]);
    } catch (error) {
      this.say('Sending failed');
      await this.reset();
      this.failed.emit(error);
      return;
    }
    this.state.set('sent');
    await Promise.all([
      animate(
        this.labelA().nativeElement,
        [
          { transform: 'translateY(0)', opacity: 1 },
          { transform: 'translateY(-110%)', opacity: 0 },
        ],
        260,
        EASE_OUT,
      ),
      animate(
        this.labelB().nativeElement,
        [
          { transform: 'translateY(110%)', opacity: 0 },
          { transform: 'translateY(0)', opacity: 1 },
        ],
        260,
        EASE_OUT,
      ),
    ]);
    this.say(this.doneLabel());
    await wait(this.resetAfter());
    await this.reset();
    this.sent.emit();
  }

  private async reset(): Promise<void> {
    for (const el of [this.labelA().nativeElement, this.labelB().nativeElement]) {
      el.getAnimations?.().forEach((a) => a.cancel());
    }
    // The plane drops back in from below-left.
    await animate(
      this.plane().nativeElement,
      [
        { transform: 'translate(-10px,8px)', opacity: 0 },
        { transform: 'translate(0,0)', opacity: 1 },
      ],
      300,
      EASE_OUT,
    );
    this.state.set('idle');
  }
}
