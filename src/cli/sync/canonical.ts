import { createHash } from 'node:crypto';

// 正準形 = サーバの GET .../text と同じ「LF 結合・末尾改行なし」。
// ファイル書き出し時は POSIX 慣習で末尾 LF を 1 つ付け、読み込み時にここで 1 つ剥がす。
export function canonicalizeText(raw: string): string {
  let text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  text = text.replaceAll('\r\n', '\n');
  if (text.endsWith('\n')) text = text.slice(0, -1);
  return text;
}

export function contentHash(canonical: string): string {
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
