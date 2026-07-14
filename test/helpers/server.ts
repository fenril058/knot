import { Hono } from 'hono';
import { openDatabase } from '../../src/storage/db.ts';
import { SqliteStorage } from '../../src/storage/sqlite.ts';
import type { Storage } from '../../src/storage/types.ts';
import { createApp } from '../../src/server/app.ts';
import { defaultConfig } from '../../src/server/config.ts';
import type { ApiEnv } from '../../src/server/http.ts';
import { hashPassword } from '../../src/server/password.ts';
import { ulid } from '../../src/core/id.ts';

export type TestServer = {
  app: Hono<ApiEnv>;
  storage: Storage;
  clock: { t: number; now: () => number };
  addUser(name: string, password: string, isAdmin?: boolean): Promise<string>;
  login(name: string, password: string): Promise<string>;
  request(path: string, init?: RequestInit, cookie?: string): Promise<Response>;
};

export async function makeServer(overrides?: { dataDir?: string }): Promise<TestServer> {
  const storage: Storage = new SqliteStorage(openDatabase(':memory:'));
  const clock = { t: 1_700_000_000, now: (): number => clock.t };
  const config = { ...defaultConfig(overrides?.dataDir ?? '/nonexistent'), secureCookie: false };
  const app = createApp({ storage, config, now: clock.now });

  const addUser = async (name: string, password: string, isAdmin = false): Promise<string> => {
    const result = await storage.addUser(
      { id: ulid(clock.t * 1000), name, displayName: name, passwordHash: hashPassword(password), isAdmin },
      clock.t,
    );
    return result.id;
  };

  const request = (path: string, init: RequestInit = {}, cookie?: string): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set('X-Knot-Client', 'test');
    if (cookie !== undefined) headers.set('Cookie', cookie);
    return Promise.resolve(app.request(path, { ...init, headers }));
  };

  const login = async (name: string, password: string): Promise<string> => {
    const res = await request('/api/knot/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, password }),
    });
    if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
    const setCookie = res.headers.get('set-cookie')!;
    return setCookie.split(';')[0]!;
  };

  return { app, storage, clock, addUser, login, request };
}
