// A small Markdown parser for chat replies. Pure: text in, a tree out, no React
// and no HTML — see markdown.tsx for rendering.
//
// WHY NOT A LIBRARY. The chat needs the handful of constructs the model
// actually emits — bold, italic, inline code, code blocks, bullet and numbered
// lists, headings, links, tables — and nothing else. A full CommonMark engine
// plus a sanitiser is a large dependency to buy for that.
//
// WHY THIS SHAPE IS THE SECURITY BOUNDARY. A model reply can contain text the
// model copied from a web page, an email or a WhatsApp message, i.e. text an
// attacker wrote. So there is deliberately NO html node in this tree: every
// leaf is a plain string that React escapes when it renders it, and the only
// attribute that ever comes from the text is a link href, which must be
// http(s). An injected <script>, <img onerror=…> or javascript: link cannot
// become markup, because nothing here can represent markup.
//
// One deliberate omission: _underscore_ italics. The model names tools like
// market_rule_add constantly, and underscore emphasis would italicise the
// middle of every one of them.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'b'; c: Inline[] }
  | { t: 'i'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] };

export interface ListItem {
  depth: number;
  c: Inline[];
}

export type Block =
  | { t: 'p'; lines: Inline[][] }
  | { t: 'h'; level: 1 | 2 | 3; c: Inline[] }
  | { t: 'ul'; items: ListItem[] }
  | { t: 'ol'; start: number; items: ListItem[] }
  | { t: 'pre'; v: string }
  | { t: 'hr' }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] };

// Order matters: code first (its contents are never parsed), then bold before
// italic so "**x**" is not read as two italics. Bold and italic require a
// non-space just inside each marker, so "5 * 3 * 2" stays arithmetic.
const TOKEN =
  /(`[^`\n]+`)|(\*\*(?=\S)[^\n]+?(?<=\S)\*\*)|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|(\*(?=[^\s*])[^*\n]+?(?<=[^\s*])\*)/g;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  // matchAll works on a copy of the regex, so recursing into bold text below
  // does not disturb this loop's position.
  for (const m of s.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ t: 'text', v: s.slice(last, at) });
    if (m[1]) out.push({ t: 'code', v: m[1].slice(1, -1) });
    else if (m[2]) out.push({ t: 'b', c: parseInline(m[2].slice(2, -2)) });
    else if (m[3]) out.push({ t: 'link', href: m[5]!, c: parseInline(m[4]!) });
    else if (m[6]) out.push({ t: 'i', c: parseInline(m[6].slice(1, -1)) });
    last = at + m[0].length;
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  return out;
}

const isRow = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string): Inline[][] =>
  l
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => parseInline(c.trim()));

export function parseMarkdown(src: string): Block[] {
  const lines = (src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: Inline[][] = [];
  const flush = (): void => {
    if (para.length) blocks.push({ t: 'p', lines: para });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Fenced code: taken verbatim, nothing inside is parsed. An unclosed fence
    // runs to the end, which is what a reply cut off by max_tokens leaves.
    if (/^\s*```/.test(line)) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) body.push(lines[i]!);
      blocks.push({ t: 'pre', v: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ t: 'h', level: Math.min(h[1]!.length, 3) as 1 | 2 | 3, c: parseInline(h[2]!) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ t: 'hr' });
      continue;
    }
    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1]!)) {
      flush();
      const head = cells(line);
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && isRow(lines[i]!); i++) rows.push(cells(lines[i]!));
      i--;
      blocks.push({ t: 'table', head, rows });
      continue;
    }
    // "* item" is a bullet; "**Price**" is not (no space after the marker).
    const ul = /^(\s*)[-*•]\s+(.*)$/.exec(line);
    if (ul) {
      flush();
      const item: ListItem = { depth: Math.floor(ul[1]!.length / 2), c: parseInline(ul[2]!) };
      const prev = blocks[blocks.length - 1];
      if (prev?.t === 'ul') prev.items.push(item);
      else blocks.push({ t: 'ul', items: [item] });
      continue;
    }
    const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (ol) {
      flush();
      const item: ListItem = { depth: Math.floor(ol[1]!.length / 2), c: parseInline(ol[3]!) };
      const prev = blocks[blocks.length - 1];
      if (prev?.t === 'ol') prev.items.push(item);
      else blocks.push({ t: 'ol', start: Number(ol[2]), items: [item] });
      continue;
    }
    para.push(parseInline(line));
  }
  flush();
  return blocks;
}
