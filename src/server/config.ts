import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ServerConfig = {
  dataDir: string;
  allowedImageHosts: string[];
  allowedMediaHosts: string[];
  allowedFrameHosts: string[];
  maxUploadBytes: number;
  secureCookie: boolean | 'auto';
  sessionTtlSeconds: number;
  autoExportDir: string | null;
  autoExportIntervalHours: number;
  autoExportKeep: number;
};

export function defaultConfig(dataDir: string): ServerConfig {
  return {
    dataDir,
    allowedImageHosts: ['i.gyazo.com', 'gyazo.com', 'scrapbox.io'],
    allowedMediaHosts: [],
    allowedFrameHosts: [],
    maxUploadBytes: 10 * 1024 * 1024,
    secureCookie: 'auto',
    sessionTtlSeconds: 30 * 24 * 60 * 60,
    autoExportDir: null,
    autoExportIntervalHours: 24,
    autoExportKeep: 7,
  };
}

function isHostArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((h) => typeof h === 'string' && /^[a-z0-9*][a-z0-9.:*-]*$/i.test(h));
}

const VALIDATORS: Record<string, (v: unknown) => boolean> = {
  allowedImageHosts: isHostArray,
  allowedMediaHosts: isHostArray,
  allowedFrameHosts: isHostArray,
  maxUploadBytes: (v) => typeof v === 'number' && Number.isInteger(v) && v > 0,
  secureCookie: (v) => typeof v === 'boolean' || v === 'auto',
  sessionTtlSeconds: (v) => typeof v === 'number' && Number.isInteger(v) && v > 0,
  autoExportDir: (v) => v === null || typeof v === 'string',
  autoExportIntervalHours: (v) => typeof v === 'number' && Number.isInteger(v) && v > 0,
  autoExportKeep: (v) => typeof v === 'number' && Number.isInteger(v) && v > 0,
};

export function loadConfig(dataDir: string): ServerConfig {
  const config = defaultConfig(dataDir);
  let raw: string;
  try {
    raw = readFileSync(join(dataDir, 'config.json'), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return config;
    throw e;
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  for (const [key, value] of Object.entries(parsed)) {
    const validate = VALIDATORS[key];
    if (!validate) throw new Error(`unknown config key: ${key}`);
    if (!validate(value)) throw new Error(`invalid config value for ${key}`);
    (config as unknown as Record<string, unknown>)[key] = value;
  }
  return config;
}
