import type { Span } from './highlight.ts';

export type PasteContext = {
  docText: string;
  from: number;
  to: number;
  spans: Span[];
};

export type PasteRule = (ctx: PasteContext) => boolean;

function positionInSpanKind(ctx: PasteContext, kind: Span['kind']): boolean {
  return ctx.spans.some(
    (span) => span.kind === kind && ctx.from >= span.from && ctx.from <= span.to,
  );
}

const inCodeBlock: PasteRule = (ctx) => positionInSpanKind(ctx, 'code-block');
const inInlineCode: PasteRule = (ctx) => positionInSpanKind(ctx, 'code-inline');

function currentLine(docText: string, offset: number): { text: string; offsetInLine: number } {
  const lineStart = docText.lastIndexOf('\n', offset - 1) + 1;
  const nextNewline = docText.indexOf('\n', offset);
  const lineEnd = nextNewline === -1 ? docText.length : nextNewline;
  return { text: docText.slice(lineStart, lineEnd), offsetInLine: offset - lineStart };
}

// カーソル行を先頭から走査し、閉じていない `[` があれば「ブラケットの内側」とみなす。
// 行内で後から `]` が現れて閉じるかどうかは問わない（未閉のブラケットも対象に含む）。
const insideBrackets: PasteRule = (ctx) => {
  const { text, offsetInLine } = currentLine(ctx.docText, ctx.from);
  let depth = 0;
  for (let i = 0; i < offsetInLine; i += 1) {
    if (text[i] === '[') depth += 1;
    else if (text[i] === ']' && depth > 0) depth -= 1;
  }
  return depth > 0;
};

export const defaultRules: readonly PasteRule[] = [inCodeBlock, inInlineCode, insideBrackets];

const SOLE_URL_PATTERN = /^https?:\/\/\S+$/;

export function transformPaste(
  ctx: PasteContext,
  pasted: string,
  rules: readonly PasteRule[] = defaultRules,
): string | null {
  const url = pasted.trim();
  if (!SOLE_URL_PATTERN.test(url)) return null;
  if (rules.some((rule) => rule(ctx))) return null;

  const selected = ctx.docText.slice(ctx.from, ctx.to);
  return selected.length === 0 ? `[${url}]` : `[${url} ${selected}]`;
}
