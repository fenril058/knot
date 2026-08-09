import { parsePageSyntax, type SyntaxNode } from '../../core/syntax.ts';

export type SpanKind =
  | 'title'
  | 'indent'
  | 'link'
  | 'external-link'
  | 'hashtag'
  | 'icon'
  | 'strong'
  | 'italic'
  | 'strike'
  | 'code-inline'
  | 'code-block'
  | 'quote'
  | 'url'
  | 'formula';

export type Span = { from: number; to: number; kind: SpanKind };

// span にならない node 型があるため戻り値に undefined を含む。そのぶん分岐漏れは
// 型エラーにならないので、未知の型は末尾で明示的に undefined にする。
function nodeKind(node: SyntaxNode): SpanKind | undefined {
  switch (node.type) {
    case 'link':
      if (node.pathType === 'relative') return 'link';
      return node.raw.startsWith('[') ? 'external-link' : 'url';
    case 'hashTag':
      return 'hashtag';
    case 'icon':
    case 'strongIcon':
      return 'icon';
    case 'strong':
      return 'strong';
    case 'decoration':
      if (node.decos.includes('/')) return 'italic';
      if (node.decos.includes('-')) return 'strike';
      if (node.decos.some((deco) => deco.startsWith('*'))) return 'strong';
      return undefined;
    case 'code':
    case 'commandLine':
      return 'code-inline';
    case 'quote':
      return 'quote';
    case 'formula':
      return 'formula';
    case 'blank':
    case 'googleMap':
    case 'helpfeel':
    case 'image':
    case 'numberList':
    case 'plain':
    case 'strongImage':
      return undefined;
    default:
      return undefined;
  }
}

function appendSpan(spans: Span[], from: number, to: number, kind: SpanKind | undefined): void {
  if (kind === undefined || from >= to) return;
  const previous = spans.at(-1);
  if (previous?.to === from && previous.kind === kind) {
    previous.to = to;
  } else {
    spans.push({ from, to, kind });
  }
}

function appendNodeSpans(
  spans: Span[],
  node: SyntaxNode,
  inheritedKind: SpanKind | undefined,
): void {
  const kind = nodeKind(node) ?? inheritedKind;
  if (!('nodes' in node) || node.nodes.length === 0) {
    appendSpan(spans, node.range.from, node.range.to, kind);
    return;
  }

  let cursor = node.range.from;
  for (const child of node.nodes) {
    appendSpan(spans, cursor, child.range.from, kind);
    appendNodeSpans(spans, child, kind);
    cursor = child.range.to;
  }
  appendSpan(spans, cursor, node.range.to, kind);
}

export function highlightSpans(docText: string): Span[] {
  const spans: Span[] = [];
  let blocks;
  try {
    blocks = parsePageSyntax(docText, { hasTitle: true });
  } catch {
    return spans;
  }

  for (const block of blocks) {
    try {
      if (block.type === 'title') {
        appendSpan(spans, block.range.from, block.range.to, 'title');
      } else if (block.type === 'line') {
        appendSpan(spans, block.range.from, block.range.from + block.indent, 'indent');
        for (const node of block.nodes) appendNodeSpans(spans, node, undefined);
      } else {
        for (const range of block.lineRanges) {
          appendSpan(spans, range.from, range.to, 'code-block');
        }
      }
    } catch {
      continue;
    }
  }
  return spans;
}
