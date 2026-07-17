import { createHash, randomBytes } from 'node:crypto';

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateApiToken(): { token: string; tokenHash: string } {
  const token = `knot_${randomBytes(24).toString('base64url')}`;
  return { token, tokenHash: hashApiToken(token) };
}
