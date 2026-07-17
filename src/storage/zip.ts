import { deflateRawSync } from 'node:zlib';
import { StorageError } from './types.ts';

export type ZipEntry = { name: string; data: Buffer; mtime: number };

const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;
const UTF8_FLAG = 1 << 11;
const DEFLATE_METHOD = 8;
const MIN_DOS_TIME_MS = Date.UTC(1980, 0, 1);
const MAX_DOS_TIME_MS = Date.UTC(2107, 11, 31, 23, 59, 58);

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < CRC32_TABLE.length; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) === 0 ? value >>> 1 : 0xedb88320 ^ (value >>> 1);
  CRC32_TABLE[i] = value >>> 0;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function assertZipLimits(
  entryCount: number,
  uncompressedSize: number,
  compressedSize: number,
  localHeaderOffset: number,
  centralDirectorySize: number,
  centralDirectoryOffset: number,
): void {
  if (entryCount >= MAX_UINT16) throw new StorageError('ZIP entry count requires ZIP64');
  const fields = [
    ['uncompressed size', uncompressedSize],
    ['compressed size', compressedSize],
    ['local header offset', localHeaderOffset],
    ['central directory size', centralDirectorySize],
    ['central directory offset', centralDirectoryOffset],
  ] as const;
  for (const [name, value] of fields) {
    if (value >= MAX_UINT32) throw new StorageError(`ZIP ${name} requires ZIP64`);
  }
}

function dosDateTime(mtime: number): { date: number; time: number } {
  const milliseconds = Math.min(MAX_DOS_TIME_MS, Math.max(MIN_DOS_TIME_MS, mtime * 1000));
  const value = new Date(milliseconds);
  const date = ((value.getUTCFullYear() - 1980) << 9) | ((value.getUTCMonth() + 1) << 5) | value.getUTCDate();
  const time = (value.getUTCHours() << 11) | (value.getUTCMinutes() << 5) | Math.floor(value.getUTCSeconds() / 2);
  return { date, time };
}

export function createZip(entries: ZipEntry[]): Buffer {
  assertZipLimits(entries.length, 0, 0, 0, 0, 0);

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    if (name.length > MAX_UINT16) throw new StorageError('ZIP entry name is too long');

    const compressed = deflateRawSync(entry.data);
    assertZipLimits(entries.length, entry.data.length, compressed.length, localOffset, 0, 0);
    const checksum = crc32(entry.data);
    const { date, time } = dosDateTime(entry.mtime);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(DEFLATE_METHOD, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(DEFLATE_METHOD, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);

    localOffset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  assertZipLimits(entries.length, 0, 0, 0, centralDirectory.length, localOffset);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);

  // v1 は ZIP 全体をメモリ上に構築する。ストリーミング化は将来課題とする。
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}
