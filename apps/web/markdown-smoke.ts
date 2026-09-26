// Chat Markdown smoke — pure: no browser, no React, no network.
//   tsx apps/web/markdown-smoke.ts
//
// The chat printed replies raw, so every reply showed literal **asterisks**.
// Two things are pinned: that real replies render cleanly, and that attacker-
// written text inside a reply (a model can quote a web page or an email) can
// never become markup. The tree has no html node type at all; these checks
// make sure it stays that way.
import { parseMarkdown, parseInline, type Block, type Inline } from './app/markdown-parse';

let fail = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};

/** Every raw string that would reach the screen as text. */
function texts(nodes: Inline[]): string[] {
  return nodes.flatMap((n) => (n.t === 'text' || n.t === 'code' ? [n.v] : texts(n.c)));
}
function allText(blocks: Block[]): string[] {
  return blocks.flatMap((b) => {
    switch (b.t) {
      case 'p':
        return b.lines.flatMap(texts);
      case 'h':
        return texts(b.c);
      case 'ul':
      case 'ol':
        return b.items.flatMap((i) => texts(i.c));
      case 'pre':
        return [b.v];
      case 'table':
        return [...b.head.flatMap(texts), ...b.rows.flatMap((r) => r.flatMap(texts))];
      default:
        return [];
    }
  });
}
const kinds = (nodes: Inline[]): string[] => nodes.map((n) => n.t);

console.log('— real replies from the owner\'s chat —');
// Verbatim, from the messages table.
const RULE_REPLY = `- **Paper rule created**: Buy 5 **RELIANCE** if price drops to/below **₹1,200**
- **Current price**: ₹1,226 (delayed, as of Fri, 25 Sept, 03:14 pm)
- **Execution**: Evaluated every 5 min during market hours; triggers once and turns off`;
const rule = parseMarkdown(RULE_REPLY);
check('a bulleted reply becomes one list', rule.length === 1 && rule[0]!.t === 'ul' && rule[0]!.items.length === 3);
check('...with NO literal asterisks left anywhere', !allText(rule).some((t) => t.includes('**')), JSON.stringify(allText(rule)).slice(0, 80));
const first = rule[0]!.t === 'ul' ? rule[0]!.items[0]!.c : [];
check('...and the bold parts are bold', kinds(first).filter((k) => k === 'b').length === 3, kinds(first).join(','));

const ADVICE = `I can’t advise on whether to buy TCS — not licensed to recommend stocks.

What I can do:
- Show current TCS price (delayed ~15 min)
- Set a rule (e.g., buy/sell at a price, or alert)

Want me to fetch TCS price?`;
const adv = parseMarkdown(ADVICE);
check('paragraphs and a list keep their order', adv.map((b) => b.t).join(',') === 'p,p,ul,p', adv.map((b) => b.t).join(','));
// The old bubble used white-space:pre-wrap, so a single newline was a visible
// line break. Markdown would normally fold it into a space; the chat must not.
const twoLines = parseMarkdown('line one\nline two');
check('a single newline is still a line break, as before', twoLines.length === 1 && twoLines[0]!.t === 'p' && twoLines[0]!.lines.length === 2);

console.log('\n— things hand-rolled Markdown usually gets wrong —');
// The model names tools constantly; underscore italics would mangle them.
check('snake_case tool names are NOT italicised', JSON.stringify(parseInline('call market_rule_add now')) === '[{"t":"text","v":"call market_rule_add now"}]');
check('arithmetic stars are not italics', parseInline('5 * 3 * 2').every((n) => n.t === 'text'));
check('an unclosed ** stays literal rather than eating the line', JSON.stringify(parseInline('**unclosed bold')) === '[{"t":"text","v":"**unclosed bold"}]');
check('"**Price**:" is bold, not a bullet', parseMarkdown('**Price**: ₹1,226')[0]!.t === 'p');
check('"* item" IS a bullet', parseMarkdown('* item')[0]!.t === 'ul');
check('markup inside `code` is not parsed', JSON.stringify(parseInline('`**x**`')) === '[{"t":"code","v":"**x**"}]');
const fenced = parseMarkdown('```\nconst a = **b**;\n  indented\n```');
check('a code block is kept verbatim, indentation included', fenced[0]!.t === 'pre' && fenced[0]!.v === 'const a = **b**;\n  indented');
check('an unclosed fence (a reply cut off mid-code) still renders', parseMarkdown('```\nhalf a').at(0)?.t === 'pre');
const ol = parseMarkdown('3. third\n4. fourth');
check('a numbered list keeps its starting number', ol[0]!.t === 'ol' && ol[0]!.start === 3 && ol[0]!.items.length === 2);
const nested = parseMarkdown('- top\n  - nested');
check('nested bullets keep their depth', nested[0]!.t === 'ul' && nested[0]!.items[1]!.depth === 1);
const table = parseMarkdown('| Symbol | Price |\n|---|---|\n| **TCS** | ₹2,082 |\n| INFY | ₹1,510 |');
check('a table is a table', table[0]!.t === 'table' && table[0]!.rows.length === 2);
check('...with inline formatting inside cells', table[0]!.t === 'table' && table[0]!.rows[0]![0]![0]!.t === 'b');
check('a heading loses its #', parseMarkdown('## Portfolio')[0]!.t === 'h' && !allText(parseMarkdown('## Portfolio')).join('').includes('#'));
check('Windows line endings do not leak \\r into the text', !allText(parseMarkdown('a\r\nb')).some((t) => t.includes('\r')));

console.log('\n— SAFETY: attacker text inside a reply stays text —');
const HOSTILE = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '**<b onmouseover=alert(1)>hover</b>**',
  '[click me](javascript:alert(1))',
  '[click me](data:text/html,<script>alert(1)</script>)',
].join('\n');
const hostile = parseMarkdown(HOSTILE);
const links: string[] = [];
const walk = (n: Inline[]): void => n.forEach((x) => (x.t === 'link' ? links.push(x.href) : 'c' in x ? walk(x.c) : undefined));
hostile.forEach((b) => (b.t === 'p' ? b.lines.forEach(walk) : undefined));
check('a javascript: link is NOT turned into a link', !links.some((h) => /^javascript:/i.test(h)), JSON.stringify(links));
check('a data: link is NOT turned into a link', !links.some((h) => /^data:/i.test(h)));
check('the HTML survives only as plain text (React escapes it)', allText(hostile).join('\n').includes('<script>alert(1)</script>'));
// Structural guarantee: the only node kinds that exist.
const seen = new Set<string>();
const collect = (n: Inline[]): void => n.forEach((x) => (seen.add(x.t), 'c' in x ? collect(x.c) : undefined));
hostile.forEach((b) => (b.t === 'p' ? b.lines.forEach(collect) : undefined));
check('no node type can carry raw HTML', [...seen].every((k) => ['text', 'b', 'i', 'code', 'link'].includes(k)), [...seen].join(','));
const ok = parseInline('[docs](https://ai.google.dev/gemini-api)');
check('a normal https link still works', ok[0]!.t === 'link' && ok[0]!.href === 'https://ai.google.dev/gemini-api');

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
