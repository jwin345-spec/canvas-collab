import { defineConfig, devices } from '@playwright/test';

const isCI = Boolean(process.env.CI);
const WEB_URL = 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run dev -w @canvas-collab/server',
      url: 'http://127.0.0.1:1234/healthz',
      reuseExistingServer: !isCI,
      env: { PERSISTENCE: 'memory', LOG_LEVEL: 'warn', NODE_ENV: 'test' },
      timeout: 60_000,
    },
    {
      command: 'npm run dev -w @canvas-collab/web',
      url: WEB_URL,
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
  ],
});
