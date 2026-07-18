import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadConfig } from '../../src/server/config.ts';

test('config.json が無ければ既定値', () => {
  const dir = mkdtempSync(join(tmpdir(), 'knot-config-'));
  assert.deepEqual(loadConfig(dir), defaultConfig(dir));
  assert.equal(loadConfig(dir).autoExportDir, null);
  assert.equal(loadConfig(dir).autoExportIntervalHours, 24);
  assert.equal(loadConfig(dir).autoExportKeep, 7);
});

test('config.json が既定値にマージされる', () => {
  const dir = mkdtempSync(join(tmpdir(), 'knot-config-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    secureCookie: false,
    allowedFrameHosts: ['www.youtube.com'],
    maxUploadBytes: 1024,
  }));
  const config = loadConfig(dir);
  assert.equal(config.secureCookie, false);
  assert.deepEqual(config.allowedFrameHosts, ['www.youtube.com']);
  assert.equal(config.maxUploadBytes, 1024);
  assert.deepEqual(config.allowedImageHosts, ['i.gyazo.com', 'gyazo.com', 'scrapbox.io']); // 未指定は既定のまま
});

test('未知キーはエラー', () => {
  const dir = mkdtempSync(join(tmpdir(), 'knot-config-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ tyop: true }));
  assert.throws(() => loadConfig(dir), /unknown config key: tyop/);
});

test('autoExportIntervalHours は 596 を許可し 597 を拒否する', () => {
  const acceptedDir = mkdtempSync(join(tmpdir(), 'knot-config-'));
  writeFileSync(join(acceptedDir, 'config.json'), JSON.stringify({ autoExportIntervalHours: 596 }));
  assert.equal(loadConfig(acceptedDir).autoExportIntervalHours, 596);

  const rejectedDir = mkdtempSync(join(tmpdir(), 'knot-config-'));
  writeFileSync(join(rejectedDir, 'config.json'), JSON.stringify({ autoExportIntervalHours: 597 }));
  assert.throws(() => loadConfig(rejectedDir), /invalid config value for autoExportIntervalHours/);
});

test('型・範囲の不正な値はエラー', () => {
  for (const bad of [
    { maxUploadBytes: -1 },
    { sessionTtlSeconds: 'thirty days' },
    { secureCookie: 'yes' },
    { allowedImageHosts: ['ok.example', 42] },
    { autoExportDir: 42 },
    { autoExportIntervalHours: -1 },
    { autoExportIntervalHours: 1.5 },
    { autoExportKeep: -1 },
    { autoExportKeep: 2.5 },
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'knot-config-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify(bad));
    assert.throws(() => loadConfig(dir), /invalid config value/);
  }
});
