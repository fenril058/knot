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
        changes.push({ from, to: from, insert: `\n${insertedLines}` });
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
