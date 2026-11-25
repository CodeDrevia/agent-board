import { linkify } from './linkify';

describe('linkify', () => {
  it('returns plain text untouched', () => {
    expect(linkify('no links here')).toEqual([{ kind: 'text', text: 'no links here' }]);
    expect(linkify(null)).toEqual([]);
  });

  it('links http and https URLs and strips trailing punctuation', () => {
    expect(linkify('PR: https://github.com/o/r/pull/628. Before/after: http://x.io/a),')).toEqual([
      { kind: 'text', text: 'PR: ' },
      { kind: 'link', text: 'https://github.com/o/r/pull/628', href: 'https://github.com/o/r/pull/628' },
      { kind: 'text', text: '. Before/after: ' },
      { kind: 'link', text: 'http://x.io/a', href: 'http://x.io/a' },
      { kind: 'text', text: '),' },
    ]);
  });

  it('keeps a balanced closing paren', () => {
    const url = 'https://en.wikipedia.org/wiki/Foo_(bar)';
    expect(linkify(`see ${url}.`)[1]).toEqual({ kind: 'link', text: url, href: url });
  });

  it('never links other schemes and leaves markup as text', () => {
    const segs = linkify('javascript:alert(1) <img src=x onerror=1> ftp://a.b');
    expect(segs.every((s) => s.kind === 'text')).toBe(true);
  });

  it('stops a URL at angle brackets and quotes', () => {
    expect(linkify('<https://a.io/x>')[1]).toEqual({ kind: 'link', text: 'https://a.io/x', href: 'https://a.io/x' });
  });
});
