const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID を生成する。now はミリ秒（Date.now() 互換）。Unix 秒を渡すと時刻順が壊れる。 */
export function ulid(now: number = Date.now()): string {
  let ts = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = ALPHABET[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const rand = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let rs = '';
  for (let i = 0; i < 16; i++) rs += ALPHABET[rand[i] % 32];
  return ts + rs;
}
