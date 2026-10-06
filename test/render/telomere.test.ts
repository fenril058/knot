import { test } from 'node:test';
import assert from 'node:assert/strict';
import { telomereWidth } from '../../src/render/telomere.ts';

const HOUR = 3600;
const DAY = 24 * HOUR;

// Cosense の公開ページで観測した、行の更新からの経過時間とテロメアの線の太さ（#239）。
void test('テロメアの線は、Cosense で観測した経過時間ごとの太さになる', () => {
  const observed: Array<[number, number]> = [
    [30 * 60, 10],
    [1.56 * HOUR, 9],
    [5.16 * HOUR, 9],
    [6.07 * HOUR, 8],
    [18.14 * HOUR, 8],
    [18.24 * HOUR, 7],
    [1.3 * DAY, 7],
    [2.68 * DAY, 6],
    [8.43 * DAY, 5],
    [16.78 * DAY, 5],
    [17.24 * DAY, 4],
    [40.55 * DAY, 4],
    [49.08 * DAY, 3],
    [124.51 * DAY, 3],
    [131.85 * DAY, 2],
    [276.37 * DAY, 2],
    [387.88 * DAY, 1],
  ];
  assert.deepEqual(observed.map(([seconds]) => telomereWidth(seconds)), observed.map(([, width]) => width));
});

void test('いま更新した行は最も太く、時計のずれで未来の時刻になっても太さの範囲に収まる', () => {
  assert.equal(telomereWidth(0), 10);
  assert.equal(telomereWidth(-600), 10);
  assert.equal(telomereWidth(10 * 365 * DAY), 1);
});
