// Renders a chat reply's Markdown as React elements.
//
// Every string below is passed to React as a text child, which React escapes.
// There is no dangerouslySetInnerHTML anywhere in this file, and that is the
// point: model replies can carry attacker-written text copied from web pages
// and messages, and building elements (never HTML strings) is what makes an
// injected <script> or onerror= inert. See markdown-parse.ts.
import type { CSSProperties, ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from './markdown-parse';

const BORDER = '#2a2e45';
const codeStyle: CSSProperties = {
  background: '#0e1020',
  border: `1px solid ${BORDER}`,
  borderRadius: 4,
  padding: '0 5px',
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  fontSize: '0.92em',
};

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return n.v;
      case 'b':
        return <strong key={i}>{inline(n.c)}</strong>;
      case 'i':
        return <em key={i}>{inline(n.c)}</em>;
      case 'code':
        return (
          <code key={i} style={codeStyle}>
            {n.v}
          </code>
        );
      case 'link':
        // href is guaranteed http(s) by the parser; it never comes from any
        // other scheme, so a javascript: link stays plain text.
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer" style={{ color: '#8ab4ff' }}>
            {inline(n.c)}
          </a>
        );
    }
  });
}

const cellStyle: CSSProperties = { border: `1px solid ${BORDER}`, padding: '4px 8px', textAlign: 'left', verticalAlign: 'top' };

function block(b: Block, key: number): ReactNode {
  switch (b.t) {
    case 'p':
      return (
        <p key={key} style={{ margin: 0 }}>
          {b.lines.map((l, i) => (
            <span key={i}>
              {i > 0 && <br />}
              {inline(l)}
            </span>
          ))}
        </p>
      );
    case 'h':
      return (
        <div key={key} style={{ fontWeight: 700, fontSize: b.level === 1 ? 16 : b.level === 2 ? 15 : 14, marginTop: 2 }}>
          {inline(b.c)}
        </div>
      );
    case 'ul':
    case 'ol': {
      const Tag = b.t;
      return (
        <Tag key={key} start={b.t === 'ol' ? b.start : undefined} style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 2 }}>
          {b.items.map((it, i) => (
            <li key={i} style={{ marginLeft: it.depth * 16 }}>
              {inline(it.c)}
            </li>
          ))}
        </Tag>
      );
    }
    case 'pre':
      return (
        <pre
          key={key}
          style={{ ...codeStyle, margin: 0, padding: '8px 10px', borderRadius: 6, whiteSpace: 'pre', overflowX: 'auto', fontSize: 12.5 }}
        >
          <code>{b.v}</code>
        </pre>
      );
    case 'hr':
      return <hr key={key} style={{ border: 'none', borderTop: `1px solid ${BORDER}`, margin: '2px 0', width: '100%' }} />;
    case 'table':
      return (
        <div key={key} style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {b.head.map((c, i) => (
                  <th key={i} style={{ ...cellStyle, fontWeight: 700 }}>
                    {inline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} style={cellStyle}>
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function Markdown({ text }: { text: string }): ReactNode {
  return <div style={{ display: 'grid', gap: 6 }}>{parseMarkdown(text).map(block)}</div>;
}
