import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignPieces, linePieces, textPosition, type AlignItem } from '../../src/client/editor/caretPosition.ts';
import { presentationLines, type PresentedLine } from '../../src/render/presentation.ts';

const config = { allowedImageHosts: ['images.example'], allowedMediaHosts: [] };

function bodyLine(source: string): PresentedLine {
  const line = presentationLines(source, new Map(), 'proj', config)[1];
  if (line === undefined) throw new Error('body line is missing');
  return line;
}

// 閲覧表示の HTML と同じく、隣り合う字の piece は 1 つの text node にまとまっている。
void test('1 つの text node にまとまった piece も、字ごとに原文の位置へ戻せる', () => {
  const source = 'Title\n1. foo [* bar]';
  const aligned = alignPieces([{ kind: 'text', text: '1. foo ' }, { kind: 'text', text: 'bar' }], linePieces(bodyLine(source)));
  assert.ok(aligned !== undefined);
  const [plain, bold] = aligned;
  assert.ok(plain?.kind === 'text' && bold?.kind === 'text');
  // 「foo」の f の前、bar の a の前。
  assert.equal(source.slice(textPosition(plain.entries, 3)), 'foo [* bar]');
  assert.equal(source.slice(textPosition(bold.entries, 1)), 'ar]');
});

void test('piece の境界は前の piece の末尾として扱い、装飾の記法の外に置く', () => {
  const source = 'Title\nab[* cd]';
  const aligned = alignPieces([{ kind: 'text', text: 'ab' }, { kind: 'text', text: 'cd' }], linePieces(bodyLine(source)));
  assert.ok(aligned !== undefined);
  const [plain, bold] = aligned;
  assert.ok(plain?.kind === 'text' && bold?.kind === 'text');
  assert.equal(source.slice(textPosition(plain.entries, 2)), '[* cd]');
  assert.equal(source.slice(textPosition(bold.entries, 0)), 'cd]');
  assert.equal(source.slice(textPosition(bold.entries, 2)), ']');
});

void test('字下げは全角空白 1 字を字下げの 1 字に対応させる', () => {
  const source = 'Title\n  body';
  const aligned = alignPieces(
    [{ kind: 'text', text: '  ' }, { kind: 'text', text: 'body' }],
    linePieces(bodyLine(source)),
  );
  assert.ok(aligned !== undefined);
  const [prefix] = aligned;
  assert.ok(prefix?.kind === 'text');
  assert.deepEqual([0, 1, 2].map((offset) => textPosition(prefix.entries, offset)), [6, 7, 8]);
});

void test('原文と字が違う piece は、前半なら node の先頭、後半なら末尾に寄せる', () => {
  const source = 'Title\n[name.icon]';
  const aligned = alignPieces([{ kind: 'text', text: '[name]' }], linePieces(bodyLine(source)));
  assert.ok(aligned !== undefined);
  const [icon] = aligned;
  assert.ok(icon?.kind === 'text');
  assert.equal(textPosition(icon.entries, 2), 6);
  assert.equal(textPosition(icon.entries, 4), 17);
});

void test('画像は字の並びの中で 1 つの node として突き合わせる', () => {
  const source = 'Title\nbefore [https://images.example/a.png] after';
  const items: AlignItem[] = [{ kind: 'text', text: 'before ' }, { kind: 'atom' }, { kind: 'text', text: ' after' }];
  const aligned = alignPieces(items, linePieces(bodyLine(source)));
  assert.ok(aligned !== undefined);
  const image = aligned[1];
  assert.ok(image?.kind === 'atom');
  assert.equal(source.slice(image.piece.span.from, image.piece.span.to), '[https://images.example/a.png]');
});

void test('DOM の字と行の字が食い違うときは対応を返さない', () => {
  const pieces = linePieces(bodyLine('Title\nserver text'));
  assert.equal(alignPieces([{ kind: 'text', text: 'stale text' }], pieces), undefined);
  assert.equal(alignPieces([{ kind: 'text', text: 'server text' }, { kind: 'text', text: 'extra' }], pieces), undefined);
  assert.equal(alignPieces([{ kind: 'text', text: 'server' }], pieces), undefined);
  assert.equal(alignPieces([{ kind: 'atom' }], pieces), undefined);
});
