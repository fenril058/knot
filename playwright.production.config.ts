import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.KNOT_PRODUCTION_URL ?? 'https://example.invalid';

export default defineConfig({
  testDir: 'e2e/production',
  fullyParallel: false,
  projects: [
    { name: 'desktop', use: { browserName: 'chromium' } },
    { name: 'mobile', use: { ...devices['iPhone 16'], browserName: 'webkit' } },
  ],
  use: {
    baseURL,
    storageState: process.env.KNOT_ACCESS_STATE ?? '.dev/access-state.json',
  },
});
