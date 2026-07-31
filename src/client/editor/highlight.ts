import { parse, type Node } from '@progfay/scrapbox-parser';

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

type SourceLine = { text: string; from: number };

function sourceLines(docText: string): SourceLine[] {
  let from = 0;
  return docText.split('\n').map((text) => {
    const line = { text, from };
    from += text.length + 1;
    return line;
  });
}

// oxlint-disable-next-line typescript/consistent-return -- union を網羅する switch。末尾の return を書かないことで、分岐漏れを型エラーにしている
function nodeKind(node: Node): SpanKind | undefined {
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
  node: Node,
  from: number,
  inheritedKind: SpanKind | undefined,
): void {
  const kind = nodeKind(node) ?? inheritedKind;
  if (!('nodes' in node) || node.nodes.length === 0) {
    appendSpan(spans, from, from + node.raw.length, kind);
    return;
  }

  let cursor = 0;
  for (const child of node.nodes) {
    const childFrom = node.raw.indexOf(child.raw, cursor);
    if (childFrom === -1) {
      appendSpan(spans, from + cursor, from + node.raw.length, kind);
      return;
    }
    appendSpan(spans, from + cursor, from + childFrom, kind);
    appendNodeSpans(spans, child, from + childFrom, kind);
    cursor = childFrom + child.raw.length;
  }
  appendSpan(spans, from + cursor, from + node.raw.length, kind);
}

function leadingWhitespaceLength(text: string): number {
  return /^\s*/.exec(text)?.[0].length ?? 0;
}

function indentedBodyLineCount(lines: SourceLine[], headerIndex: number, headerIndent: number): number {
  let count = 0;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (leadingWhitespaceLength(lines[index]!.text) <= headerIndent) break;
    count += 1;
  }
  return count;
}

export function highlightSpans(docText: string): Span[] {
  const lines = sourceLines(docText);
  const spans: Span[] = [];
  let blocks;
  try {
    blocks = parse(docText, { hasTitle: true });
  } catch {
    return spans;
  }

  let lineIndex = 0;
  for (const block of blocks) {
    try {
      const line = lines[lineIndex];
      if (line === undefined) break;

      if (block.type === 'title') {
        if (line.text === block.text) appendSpan(spans, line.from, line.from + line.text.length, 'title');
        lineIndex += 1;
      } else if (block.type === 'line') {
        const content = line.text.slice(block.indent);
        if (block.indent <= line.text.length && block.nodes.map((node) => node.raw).join('') === content) {
          appendSpan(spans, line.from, line.from + block.indent, 'indent');
          let withinLine = block.indent;
          for (const node of block.nodes) {
            appendNodeSpans(spans, node, line.from + withinLine, undefined);
            withinLine += node.raw.length;
          }
        }
        lineIndex += 1;
      } else {
        const bodyLineCount = indentedBodyLineCount(lines, lineIndex, block.indent);
        for (let offset = 0; offset <= bodyLineCount; offset += 1) {
          const blockLine = lines[lineIndex + offset];
          if (blockLine !== undefined) {
            appendSpan(spans, blockLine.from, blockLine.from + blockLine.text.length, 'code-block');
          }
        }
        lineIndex += 1 + bodyLineCount;
      }
    } catch {
      lineIndex += 1;
    }
  }
  return spans;
}
