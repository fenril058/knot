const startsWith = (bytes: Uint8Array, offset: number, expected: number[]): boolean =>
  bytes.length >= offset + expected.length && expected.every((value, index) => bytes[offset + index] === value);

export const INLINE_TYPES: readonly string[] = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
]);

export const MAGIC: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = Object.freeze({
  'image/png': (bytes: Uint8Array) => startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47]),
  'image/jpeg': (bytes: Uint8Array) => startsWith(bytes, 0, [0xff, 0xd8, 0xff]),
  'image/gif': (bytes: Uint8Array) => startsWith(bytes, 0, [0x47, 0x49, 0x46, 0x38]),
  'image/webp': (bytes: Uint8Array) =>
    startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50]),
  'video/mp4': (bytes: Uint8Array) => startsWith(bytes, 4, [0x66, 0x74, 0x79, 0x70]),
  'video/webm': (bytes: Uint8Array) => startsWith(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3]),
  'audio/mpeg': (bytes: Uint8Array) =>
    startsWith(bytes, 0, [0x49, 0x44, 0x33]) ||
    (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0),
  'audio/ogg': (bytes: Uint8Array) => startsWith(bytes, 0, [0x4f, 0x67, 0x67, 0x53]),
  'audio/wav': (bytes: Uint8Array) =>
    startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, 8, [0x57, 0x41, 0x56, 0x45]),
});
