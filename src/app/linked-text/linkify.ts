export type TextSegment = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string };

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?'")\]}>]+$/;

/** Split plain text into text and http(s) link segments. Never produces HTML. */
export function linkify(input: string | null | undefined): TextSegment[] {
  const text = input ?? '';
  const out: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    let url = match[0];
    // Keep a closing paren that balances one inside the URL (e.g. wiki links).
    let trail = url.match(TRAILING)?.[0] ?? '';
    while (trail.startsWith(')') && count(url, '(') >= count(url, ')')) trail = trail.slice(1);
    url = url.slice(0, url.length - trail.length);
    if (!isHttpUrl(url)) continue;
    if (start > last) out.push({ kind: 'text', text: text.slice(last, start) });
    out.push({ kind: 'link', text: url, href: url });
    last = start + url.length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}
