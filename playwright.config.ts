import { defineConfig } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 4173);

export default defineConfig({
  testDir: 'e2e',
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: 'npm run build:client && node e2e/server.ts',
    url: `http://127.0.0.1:${port}/login`,
    reuseExistingServer: false,
  },
});
