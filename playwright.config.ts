import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 4173);

export default defineConfig({
  testDir: 'e2e',
  testIgnore: /production\//,
  projects: [
    {
      name: 'chromium',
      testIgnore: [/mobile\.spec\.ts/, /production\//],
      use: { browserName: 'chromium' },
    },
    {
      name: 'mobile-chromium',
      testMatch: /mobile\.spec\.ts/,
      use: { ...devices['Galaxy S24'], browserName: 'chromium' },
    },
    {
      name: 'mobile-webkit',
      testMatch: /mobile\.spec\.ts/,
      use: { ...devices['iPhone 16'], browserName: 'webkit' },
    },
  ],
  // 失敗したテストだけ trace と screenshot を test-results/ に残す。CI は失敗時にこれを artifact にする。
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run build:client && node e2e/server.ts',
    url: `http://127.0.0.1:${port}/login`,
    reuseExistingServer: false,
  },
});
