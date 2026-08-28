import { ChangeSet, EditorSelection, type ChangeDesc, type SelectionRange } from '@codemirror/state';
import type { Line } from '../../core/ops.ts';

type LineAlignment = { beforeIndex: number; afterIndex: number };
export type DocumentChange = { from: number; to: number; insert: string };

function lineStarts(lines: readonly Pick<Line, 'id' | 'text'>[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.text.length + 1;
  }
  return starts;
}

function lineAtPosition(
  lines: readonly Pick<Line, 'id' | 'text'>[],
  starts: readonly number[],
  position: number,
): { line: Pick<Line, 'id' | 'text'>; column: number } | undefined {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle]! <= position) low = middle + 1;
    else high = middle;
  }
  const index = low - 1;
  const line = lines[index];
  return line === undefined ? undefined : { line, column: position - starts[index]! };
}

function alignLinesById(
  before: readonly Pick<Line, 'id' | 'text'>[],
  after: readonly Pick<Line, 'id' | 'text'>[],
): LineAlignment[] {
  const afterIndexById = new Map(after.map((line, index) => [line.id, index]));
  const candidates = before.flatMap((line, beforeIndex) => {
    const afterIndex = afterIndexById.get(line.id);
    return afterIndex === undefined ? [] : [{ beforeIndex, afterIndex }];
  });
  if (candidates.length === 0) return [];

  // Shared IDs are unique. Their longest increasing subsequence is the largest set of
  // logical lines whose order can remain unchanged in both documents.
  const previous = Array.from<number>({ length: candidates.length }).fill(-1);
  const tails: number[] = [];
  for (let index = 0; index < candidates.length; index++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (candidates[tails[middle]!]!.afterIndex < candidates[index]!.afterIndex) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1]!;
    tails[low] = index;
  }

  const alignments: LineAlignment[] = [];
  let index = tails[tails.length - 1]!;
  while (index !== -1) {
    alignments.push(candidates[index]!);
    index = previous[index]!;
  }
  return alignments.toReversed();
}

function lineTextChange(lineStart: number, before: string, after: string): DocumentChange | null {
  if (before === after) return null;
  const beforeCodePoints = Array.from(before);
  const afterCodePoints = Array.from(after);
  let prefixLength = 0;
  while (
    prefixLength < beforeCodePoints.length
    && prefixLength < afterCodePoints.length
    && beforeCodePoints[prefixLength] === afterCodePoints[prefixLength]
  ) {
    prefixLength++;
  }
  let suffixLength = 0;
  while (
    beforeCodePoints.length - suffixLength > prefixLength
    && afterCodePoints.length - suffixLength > prefixLength
    && beforeCodePoints[beforeCodePoints.length - suffixLength - 1]
      === afterCodePoints[afterCodePoints.length - suffixLength - 1]
  ) {
    suffixLength++;
  }

  const prefix = beforeCodePoints.slice(0, prefixLength).join('');
  const suffix = beforeCodePoints.slice(beforeCodePoints.length - suffixLength).join('');
  return {
    from: lineStart + prefix.length,
    to: lineStart + before.length - suffix.length,
    insert: afterCodePoints.slice(prefixLength, afterCodePoints.length - suffixLength).join(''),
  };
}

function linesText(lines: readonly Pick<Line, 'id' | 'text'>[], from: number, to: number): string {
  return lines.slice(from, to).map((line) => line.text).join('\n');
}

export function documentChanges(
  before: readonly Pick<Line, 'id' | 'text'>[],
  after: readonly Pick<Line, 'id' | 'text'>[],
): DocumentChange[] {
  const beforeStarts = lineStarts(before);
  const beforeTextLength = before.reduce((length, line, index) => length + line.text.length + (index === 0 ? 0 : 1), 0);
  const alignments = alignLinesById(before, after);
  const changes: DocumentChange[] = [];
  let previousBeforeIndex = -1;
  let previousAfterIndex = -1;

  for (let alignmentIndex = 0; alignmentIndex <= alignments.length; alignmentIndex++) {
    const alignment = alignments[alignmentIndex];
    const nextBeforeIndex = alignment?.beforeIndex ?? before.length;
    const nextAfterIndex = alignment?.afterIndex ?? after.length;
    const beforeBlockStart = previousBeforeIndex + 1;
    const afterBlockStart = previousAfterIndex + 1;

    if (beforeBlockStart !== nextBeforeIndex || afterBlockStart !== nextAfterIndex) {
      const insertedLines = linesText(after, afterBlockStart, nextAfterIndex);
      const isInsertion = beforeBlockStart === nextBeforeIndex && afterBlockStart !== nextAfterIndex;
      if (alignment !== undefined && isInsertion && previousBeforeIndex !== -1) {
        const previousLine = before[previousBeforeIndex]!;
        const from = beforeStarts[previousBeforeIndex]! + previousLine.text.length;
        changes.push({ from, to: beforeStarts[nextBeforeIndex]!, insert: `\n${insertedLines}\n` });
      } else if (alignment !== undefined) {
        const from = beforeStarts[beforeBlockStart]!;
        changes.push({
          from,
          to: beforeStarts[nextBeforeIndex]!,
          insert: insertedLines === '' && afterBlockStart === nextAfterIndex ? '' : `${insertedLines}\n`,
        });
      } else if (previousBeforeIndex === -1) {
        changes.push({ from: 0, to: beforeTextLength, insert: insertedLines });
      } else {
        const previousLine = before[previousBeforeIndex]!;
        const from = beforeStarts[previousBeforeIndex]! + previousLine.text.length;
        changes.push({
          from,
          to: beforeTextLength,
          insert: insertedLines === '' && afterBlockStart === nextAfterIndex ? '' : `\n${insertedLines}`,
        });
      }
    }

    if (alignment === undefined) break;
    const textChange = lineTextChange(
      beforeStarts[alignment.beforeIndex]!,
      before[alignment.beforeIndex]!.text,
      after[alignment.afterIndex]!.text,
    );
    if (textChange !== null) changes.push(textChange);
    previousBeforeIndex = alignment.beforeIndex;
    previousAfterIndex = alignment.afterIndex;
  }

  return changes;
}

function mapLineColumn(before: string, after: string, column: number, assoc: number): number {
  const change = lineTextChange(0, before, after);
  return change === null
    ? column
    : ChangeSet.of(change, before.length).mapPos(column, assoc);
}

function mapSelectionPosition(
  before: readonly Pick<Line, 'id' | 'text'>[],
  after: readonly Pick<Line, 'id' | 'text'>[],
  beforeStarts: readonly number[],
  afterStarts: readonly number[],
  afterIndexById: ReadonlyMap<string, number>,
  position: number,
  assoc: number,
  fallback: number,
): number {
  const located = lineAtPosition(before, beforeStarts, position);
  if (located === undefined) return fallback;
  const afterIndex = afterIndexById.get(located.line.id);
  if (afterIndex === undefined) return fallback;
  const afterLine = after[afterIndex]!;
  return afterStarts[afterIndex]!
    + mapLineColumn(located.line.text, afterLine.text, located.column, assoc);
}

function mappedRange(
  before: readonly Pick<Line, 'id' | 'text'>[],
  after: readonly Pick<Line, 'id' | 'text'>[],
  beforeStarts: readonly number[],
  afterStarts: readonly number[],
  afterIndexById: ReadonlyMap<string, number>,
  range: SelectionRange,
  changes: ChangeDesc,
): SelectionRange {
  const fallback = range.map(changes);
  const anchorAssoc = range.empty ? -1 : range.anchor === range.from ? 1 : -1;
  const headAssoc = range.empty ? -1 : range.head === range.from ? 1 : -1;
  const anchor = mapSelectionPosition(
    before,
    after,
    beforeStarts,
    afterStarts,
    afterIndexById,
    range.anchor,
    anchorAssoc,
    fallback.anchor,
  );
  const head = mapSelectionPosition(
    before,
    after,
    beforeStarts,
    afterStarts,
    afterIndexById,
    range.head,
    headAssoc,
    fallback.head,
  );
  if (range.empty) {
    return EditorSelection.cursor(anchor, range.assoc, range.bidiLevel ?? undefined, range.goalColumn);
  }
  if (range.undirectional) return EditorSelection.undirectionalRange(Math.min(anchor, head), Math.max(anchor, head));
  return EditorSelection.range(anchor, head, range.goalColumn, range.bidiLevel ?? undefined, range.assoc);
}

// 残存行の端点は同じ行 ID へ写し、削除された行の端点だけを ChangeSet の位置写像へ委ねる。
export function mapSelectionByLineId(
  before: readonly Pick<Line, 'id' | 'text'>[],
  after: readonly Pick<Line, 'id' | 'text'>[],
  selection: EditorSelection,
  changes: ChangeDesc,
): EditorSelection {
  const beforeStarts = lineStarts(before);
  const afterStarts = lineStarts(after);
  const afterIndexById = new Map(after.map((line, index) => [line.id, index]));
  return EditorSelection.create(selection.ranges.map((range) => mappedRange(
    before,
    after,
    beforeStarts,
    afterStarts,
    afterIndexById,
    range,
    changes,
  )), selection.mainIndex);
}
