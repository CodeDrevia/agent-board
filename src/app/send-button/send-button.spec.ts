import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { SendButton } from './send-button';

@Component({
  imports: [SendButton],
  template: `<app-send-button
    label="Post comment"
    doneLabel="Posted"
    [resetAfter]="0"
    [action]="action()"
    (sent)="sent()"
    (failed)="failed()"
  />`,
})
class Host {
  readonly action = signal<() => Promise<unknown>>(() => Promise.resolve());
  readonly sent = vi.fn();
  readonly failed = vi.fn();
}

function setup(action: () => Promise<unknown>) {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.action.set(action);
  fixture.detectChanges();
  const el: HTMLElement = fixture.nativeElement;
  return { fixture, host: fixture.componentInstance, el, button: el.querySelector('button')! };
}

describe('SendButton', () => {
  it('keeps flying until the request settles, then shows the done label', async () => {
    let finish!: () => void;
    const action = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const { fixture, host, el, button } = setup(action);

    button.click();
    fixture.detectChanges();
    expect(action).toHaveBeenCalledTimes(1);
    expect(el.querySelector('app-send-button')!.getAttribute('data-state')).toBe('sending');
    expect(button.getAttribute('aria-disabled')).toBe('true');

    button.click(); // ignored while in flight
    expect(action).toHaveBeenCalledTimes(1);

    finish();
    await vi.waitFor(() => expect(host.sent).toHaveBeenCalled());
    fixture.detectChanges();
    expect(host.failed).not.toHaveBeenCalled();
    expect(el.querySelector('[role=status]')!.textContent).toContain('Posted');
    expect(el.querySelector('app-send-button')!.getAttribute('data-state')).toBe('idle');
  });

  it('rolls back and announces failure when the request rejects', async () => {
    const { fixture, host, el, button } = setup(() => Promise.reject(new Error('boom')));
    button.click();
    await vi.waitFor(() => expect(host.failed).toHaveBeenCalled());
    fixture.detectChanges();
    expect(host.sent).not.toHaveBeenCalled();
    expect(el.querySelector('[role=status]')!.textContent).toContain('Sending failed');
    expect(el.querySelector('app-send-button')!.getAttribute('data-state')).toBe('idle');
    expect(button.getAttribute('aria-disabled')).toBeNull();
  });
});
