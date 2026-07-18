import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StorageError } from '../../src/storage/types.ts';
import { accumulateCentralDirectorySize, assertZipLimits, createZip, type ZipEntry } from '../../src/storage/zip.ts';
import { readZip } from '../helpers/zip.ts';

const MTIME = Date.UTC(2024, 5, 7, 8, 9, 11) / 1000;

test('テキストと 0 バイトのエントリを round-trip する', () => {
  const entries: ZipEntry[] = [
    { name: 'hello.txt', data: Buffer.from('hello'), mtime: MTIME },
    { name: 'empty', data: Buffer.alloc(0), mtime: MTIME },
  ];
  assert.deepEqual(readZip(createZip(entries)), entries.map(({ name, data }) => ({ name, data })));
});

test('スラッシュを含む日本語ファイル名を round-trip する', () => {
  const entry = { name: '日本語/添付.png', data: Buffer.from([0, 1, 2]), mtime: MTIME };
  assert.deepEqual(readZip(createZip([entry])), [{ name: entry.name, data: entry.data }]);
});

test('同一入力と同一 mtime から決定的な出力を作る', () => {
  const entries = [{ name: 'same.txt', data: Buffer.from('same'), mtime: MTIME }];
  assert.deepEqual(createZip(entries), createZip(entries));
});

test('改竄されたデータを CRC32 不一致で拒否する', () => {
  const zip = createZip([{ name: 'crc.txt', data: Buffer.from('crc check'), mtime: MTIME }]);
  const nameLength = zip.readUInt16LE(26);
  const extraLength = zip.readUInt16LE(28);
  const dataOffset = 30 + nameLength + extraLength;
  zip[dataOffset + 2]! ^= 1;
  assert.throws(() => readZip(zip), /CRC32 mismatch/);
});

test('ローカルファイルヘッダと EOCD のシグネチャを出力する', () => {
  const zip = createZip([{ name: 'magic', data: Buffer.alloc(0), mtime: MTIME }]);
  assert.equal(zip.subarray(0, 4).toString('binary'), 'PK\x03\x04');
  assert.notEqual(zip.lastIndexOf(Buffer.from('PK\x05\x06', 'binary')), -1);
});

test('ZIP64 の sentinel 値に達するエントリ数を拒否する', () => {
  const entry = { name: '', data: Buffer.alloc(0), mtime: MTIME };
  assert.doesNotThrow(() => createZip(Array.from({ length: 0xfffe }, () => entry)));
  assert.throws(() => createZip(Array.from({ length: 0xffff }, () => entry)), StorageError);
});

test('ZIP64 の 32-bit sentinel 値をすべての対象フィールドで拒否する', () => {
  const accepted = 0xfffffffe;
  assert.doesNotThrow(() => assertZipLimits(0xfffe, accepted, accepted, accepted, accepted, accepted));
  for (let index = 1; index < 6; index++) {
    const values = [0xfffe, accepted, accepted, accepted, accepted, accepted];
    values[index] = 0xffffffff;
    assert.throws(() => assertZipLimits(...(values as [number, number, number, number, number, number])), StorageError);
  }
});

test('central directory の累積サイズを Buffer.concat 前に検査する', () => {
  assert.equal(accumulateCentralDirectorySize(10, 46, 4), 60);
  assert.equal(accumulateCentralDirectorySize(0xfffffffe - 50, 46, 4), 0xfffffffe);
  assert.throws(() => accumulateCentralDirectorySize(0xfffffffe - 49, 46, 4), /central directory size requires ZIP64/);
});

function localDosDateTime(zip: Buffer): { date: number; time: number } {
  return { time: zip.readUInt16LE(10), date: zip.readUInt16LE(12) };
}

function zipWithMtime(mtime: number): Buffer {
  return createZip([{ name: 'time', data: Buffer.alloc(0), mtime }]);
}

test('DOS 時刻を範囲内へ clamp し、奇数秒を偶数へ切り下げる', () => {
  assert.deepEqual(localDosDateTime(zipWithMtime(Date.UTC(1970, 0, 1) / 1000)), { date: 0x0021, time: 0x0000 });
  assert.deepEqual(localDosDateTime(zipWithMtime(Date.UTC(2200, 0, 1) / 1000)), { date: 0xff9f, time: 0xbf7d });
  assert.deepEqual(localDosDateTime(zipWithMtime(Date.UTC(2024, 0, 2, 3, 4, 5) / 1000)), {
    date: ((2024 - 1980) << 9) | (1 << 5) | 2,
    time: (3 << 11) | (4 << 5) | 2,
  });
});
