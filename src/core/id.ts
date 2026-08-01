const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// ULID の時刻部分は 48 bit。
const MAX_TIME = 2 ** 48 - 1;

/** ULID を生成する。now はミリ秒（Date.now() 互換）。Unix 秒を渡すと時刻順が壊れる。 */
export function ulid(now: number = Date.now()): string {
  // 範囲外や非整数だと ALPHABET の添字が外れ、'undefined' を含む ID を黙って返してしまう。
  // ID の破損は後段で気づけないので、ここで落とす。
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) {
    throw new RangeError(`ulid: now must be an integer in [0, ${MAX_TIME}], got ${now}`);
  }
  let ts = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = ALPHABET[t % 32]! + ts;
    t = Math.floor(t / 32);
  }
  const rand = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let rs = '';
  // ALPHABET は 32 文字、rand は長さ 16 なのでどちらの添字も範囲内。
  for (let i = 0; i < 16; i++) rs += ALPHABET[rand[i]! % 32]!;
  return ts + rs;
}
