import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N, r: R, p: P });
  return `scrypt:${N}:${R}:${P}:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  // 保存形式は hashPassword が発行する 1 種類に固定する。
  // DB 内の値をそのまま scryptSync に渡すと、巨大な N を仕込まれたときに
  // イベントループを止められる（保存値由来の DoS）ため、パラメータは検証せず照合で弾く。
  if (parts[1] !== String(N) || parts[2] !== String(R) || parts[3] !== String(P)) return false;
  // 直前に parts.length === 6 を確認済み。
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (salt.length !== 16 || expected.length !== 32) return false;
  try {
    const actual = scryptSync(password, salt, expected.length, { N, r: R, p: P });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
