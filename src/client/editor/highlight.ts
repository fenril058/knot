import { splitLineId } from '../../core/links.ts';
import { isAttachmentUrl } from '../../core/media.ts';
import { parsePageSyntax, type SyntaxNode } from '../../core/syntax.ts';
import { strongLevel } from '../../render/presentation.ts';

export type SpanKind =
  | 'title'
  | 'indent'
  | 'link'
  | 'empty-link'
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

// 装飾の見た目。カーソル行でも閲覧表示と同じ字の形で描くため、装飾の範囲（[ と記号を含む）と、
// その中のリンクなどの span に重ねて付ける（#267）。level-N は強調の段階（閲覧表示の strong.level-N）。
export type SpanStyle = 'strong' | 'italic' | 'strike' | `level-${number}`;

export type Span = { from: number; to: number; kind: SpanKind; styles?: readonly SpanStyle[] };

// ページがあるかどうか。渡されたときは、閲覧表示と同じくページの無いリンクとハッシュタグを
// empty-link にする（カーソル行でも空リンクの色を保つ、#273）。
export type IsKnownTitle = (title: string) => boolean;

// span にならない node 型があるため戻り値に undefined を含む。そのぶん分岐漏れは
// 型エラーにならないので、未知の型は末尾で明示的に undefined にする。
function nodeKind(node: SyntaxNode, isKnownTitle: IsKnownTitle | undefined): SpanKind | undefined {
  switch (node.type) {
    case 'link':
      if (node.pathType === 'relative') {
        return isKnownTitle === undefined || isKnownTitle(splitLineId(node.href).target) ? 'link' : 'empty-link';
      }
      // 別のプロジェクトへのリンクは、閲覧表示と同じくページへのリンクの色（#287）。
      if (node.pathType === 'root' && !isAttachmentUrl(node.href)) return 'link';
      return node.raw.startsWith('[') ? 'external-link' : 'url';
    case 'hashTag':
      return isKnownTitle === undefined || isKnownTitle(node.href) ? 'hashtag' : 'empty-link';
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

// 閲覧表示と同じく、強調は段階 1 なら本文と同じ大きさの太字、2 以上なら大きい字にする。
function decorationStyles(node: SyntaxNode): SpanStyle[] {
  if (node.type !== 'decoration') return [];
  const styles: SpanStyle[] = [];
  const level = strongLevel(node.decos);
  if (level !== undefined) styles.push('strong');
  if (level !== undefined && level > 1) styles.push(`level-${level}`);
  if (node.decos.includes('/')) styles.push('italic');
  if (node.decos.includes('-')) styles.push('strike');
  return styles;
}

function appendSpan(
  spans: Span[],
  from: number,
  to: number,
  kind: SpanKind | undefined,
  styles: readonly SpanStyle[],
): void {
  if (kind === undefined || from >= to) return;
  const previous = spans.at(-1);
  if (previous?.to === from && previous.kind === kind && (previous.styles ?? []).join() === styles.join()) {
    previous.to = to;
  } else {
    spans.push(styles.length === 0 ? { from, to, kind } : { from, to, kind, styles });
  }
}

function appendNodeSpans(
  spans: Span[],
  node: SyntaxNode,
  inheritedKind: SpanKind | undefined,
  inheritedStyles: readonly SpanStyle[],
  isKnownTitle: IsKnownTitle | undefined,
): void {
  const kind = nodeKind(node, isKnownTitle) ?? inheritedKind;
  const ownStyles = decorationStyles(node);
  const styles = ownStyles.length === 0 ? inheritedStyles : [...inheritedStyles, ...ownStyles];
  if (!('nodes' in node) || node.nodes.length === 0) {
    appendSpan(spans, node.range.from, node.range.to, kind, styles);
    return;
  }

  let cursor = node.range.from;
  for (const child of node.nodes) {
    appendSpan(spans, cursor, child.range.from, kind, styles);
    appendNodeSpans(spans, child, kind, styles, isKnownTitle);
    cursor = child.range.to;
  }
  appendSpan(spans, cursor, node.range.to, kind, styles);
}

export function highlightSpans(docText: string, isKnownTitle?: IsKnownTitle): Span[] {
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
        appendSpan(spans, block.range.from, block.range.to, 'title', []);
      } else if (block.type === 'line') {
        appendSpan(spans, block.range.from, block.range.from + block.indent, 'indent', []);
        for (const node of block.nodes) appendNodeSpans(spans, node, undefined, [], isKnownTitle);
      } else {
        for (const range of block.lineRanges) {
          appendSpan(spans, range.from, range.to, 'code-block', []);
        }
      }
    } catch {
      continue;
    }
  }
  return spans;
}
