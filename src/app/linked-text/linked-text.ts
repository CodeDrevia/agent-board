import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { linkify } from './linkify';

/** Renders plain text with every http(s) URL as a link; text stays escaped by interpolation. */
@Component({
  selector: 'app-linked-text',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (seg of segments(); track $index) {@if (seg.kind === 'link') {<a [href]="seg.href" target="_blank" rel="noopener noreferrer">{{ seg.text }}</a>} @else {<span>{{ seg.text }}</span>}}`,
  styles: `:host { white-space: inherit; } a { color: inherit; text-decoration: underline; overflow-wrap: anywhere; }`,
})
export class LinkedText {
  readonly text = input<string | null | undefined>('');
  protected readonly segments = computed(() => linkify(this.text()));
}
