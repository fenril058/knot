import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now: number = Date.now()): string {
  let ts = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = ALPHABET[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(16);
  let rs = '';
  for (let i = 0; i < 16; i++) rs += ALPHABET[rand[i] % 32];
  return ts + rs;
}
