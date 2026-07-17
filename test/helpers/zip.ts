import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

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

export function readZip(buf: Buffer): { name: string; data: Buffer }[] {
  let eocdOffset = -1;
  for (let offset = buf.length - 22; offset >= 0; offset--) {
    if (buf.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocdOffset = offset;
      break;
    }
  }
  assert.notEqual(eocdOffset, -1, 'EOCD not found');

  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  let offset = buf.readUInt32LE(eocdOffset + 16);
  const entries: { name: string; data: Buffer }[] = [];

  for (let i = 0; i < entryCount; i++) {
    assert.equal(buf.readUInt32LE(offset), CENTRAL_DIRECTORY_SIGNATURE, 'invalid central directory signature');
    assert.notEqual(buf.readUInt16LE(offset + 8) & (1 << 11), 0, 'UTF-8 flag is not set');
    assert.equal(buf.readUInt16LE(offset + 10), 8, 'unsupported compression method');
    const expectedCrc = buf.readUInt32LE(offset + 16);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    const localNameLength = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buf.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const data = inflateRawSync(buf.subarray(dataOffset, dataOffset + compressedSize));
    assert.equal(crc32(data), expectedCrc, `CRC32 mismatch for ${name}`);
    entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
