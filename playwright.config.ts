import { defineConfig, devices } from '@playwright/test';

/**
 * Visual regression configuration.
 *
 * The maths tests run in three browser engines rather than three webviews. Playwright
 * ships WebKit and Gecko builds, and between them they cover the layout engines that
 * Tauri's three platform webviews are built on: WebKit (macOS and, more or less,
 * WebKitGTK), Blink (WebView2). MathML support differs between them, which is the
 * whole reason the rendering path is tested here at all.
 *
 * Snapshots are platform-specific because the engines genuinely render differently.
 * A shared baseline would hide exactly the discrepancy this suite exists to catch.
 */
export default defineConfig({
  testDir: './tests/visual',
  outputDir: './test-results',
  snapshotDir: './tests/__screenshots__',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: 'http://127.0.0.1:4173',
    // Deterministic rendering: animations and caret blinking make screenshots
    // irreproducible.
    reducedMotion: 'reduce',
    deviceScaleFactor: 2,
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
  ],

  webServer: {
    // `--host 127.0.0.1` is explicit because Vite's default `localhost` resolves to
    // IPv6 on some machines, and Playwright's readiness probe uses IPv4.
    command:
      'pnpm --filter @adnota/web preview --port 4173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
