// タイトル⇔ファイル名の単射エスケープ。
// 方針: 可読性優先でタイトルをそのまま使い、FS で問題になる文字だけ %XX にする。
// エスケープ対象は ASCII のみなので %XX は常に 1 バイト = 1 文字。% 自体も
// エスケープするため逆変換は一意に定まる。

const UNSAFE = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*', '%']);

const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

function hex(ch: string): string {
  return `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
}

export function titleToFilename(title: string): string {
  let out = '';
  for (const ch of title) {
    out += UNSAFE.has(ch) || ch.charCodeAt(0) < 0x20 ? hex(ch) : ch;
  }
  if (out.startsWith('.')) out = hex('.') + out.slice(1);
  const last = out.at(-1);
  if (last === ' ' || last === '.') out = out.slice(0, -1) + hex(last);
  const reservedStem = out.includes('.') ? out.slice(0, out.indexOf('.')) : out;
  if (RESERVED.has(reservedStem.toLowerCase())) out = hex(out[0]!) + out.slice(1);
  return `${out}.txt`;
}

export function filenameToTitle(filename: string): string {
  const stem = filename.endsWith('.txt') ? filename.slice(0, -4) : filename;
  return stem.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}
