const { defineConfig } = require('@playwright/test');
const port = Number(process.env.WORKBENCH_E2E_PORT || 18755);
module.exports = defineConfig({
  testDir: './tests/browser', timeout: 30000, workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: 'chromium', channel: process.env.WORKBENCH_BROWSER_CHANNEL || undefined, viewport: { width: 1366, height: 768 }, trace: 'retain-on-failure' },
  webServer: { command: 'node tests/browser/server.cjs', url: `http://127.0.0.1:${port}/api/health`, reuseExistingServer: false, timeout: 30000 },
});
