import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AuthenticationAdapter } from '../server/application.ts';
import { jsonError } from '../server/http.ts';

const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

export type AccessConfig = {
  issuer: string;
  audience: string;
  email: string;
  accountId: string;
  actorId: string;
};

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`);
  return value;
}

function normalizeIssuer(value: unknown): string {
  const issuer = requiredString(value, 'issuer');
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error('issuer must be a valid URL');
  }
  if (
    url.protocol !== 'https:' || !url.hostname.endsWith('.cloudflareaccess.com') || url.port !== '' ||
    url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== ''
  ) {
    throw new Error('issuer must be an HTTPS cloudflareaccess.com origin');
  }
  return url.origin;
}

export function parseAccessConfig(serialized: string): AccessConfig {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('KNOT_ACCESS_CONFIG must be valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('KNOT_ACCESS_CONFIG must be a JSON object');
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape is validated field by field below.
  const object = value as Record<string, unknown>;
  return {
    issuer: normalizeIssuer(object.issuer),
    audience: requiredString(object.audience, 'audience'),
    email: requiredString(object.email, 'email'),
    accountId: requiredString(object.accountId, 'accountId'),
    actorId: requiredString(object.actorId, 'actorId'),
  };
}

function createAccessJwkSet(config: AccessConfig): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`));
}

async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
  key: JWTVerifyGetKey,
): Promise<string> {
  const { payload } = await jwtVerify(token, key, {
    algorithms: ['RS256'],
    issuer: config.issuer,
    audience: config.audience,
    requiredClaims: ['exp', 'email'],
  });
  if (typeof payload.email !== 'string' || payload.email === '') throw new Error('Access token has no email claim');
  return payload.email;
}

export function createAccessAuthenticationAdapter(
  config: AccessConfig,
  key: JWTVerifyGetKey = createAccessJwkSet(config),
): AuthenticationAdapter {
  return async (c) => {
    const token = c.req.header(ACCESS_JWT_HEADER);
    if (token === undefined || token === '') {
      return { kind: 'response', response: jsonError(c, 401, 'unauthorized') };
    }
    let email: string;
    try {
      email = await verifyAccessJwt(token, config, key);
    } catch {
      return { kind: 'response', response: jsonError(c, 401, 'unauthorized') };
    }
    if (email !== config.email) {
      return { kind: 'response', response: jsonError(c, 403, 'forbidden') };
    }
    return {
      kind: 'authenticated',
      accountId: config.accountId,
      actorId: config.actorId,
    };
  };
}
