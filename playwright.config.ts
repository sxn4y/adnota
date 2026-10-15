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
  /**
   * Capped rather than left to Playwright's default (half the logical cores).
   *
   * Three engines at full parallelism starve the slowest of them: Firefox intermittently
   * exceeded even a 60s navigation timeout while Chromium and WebKit finished in
   * seconds. Each project is internally parallel, so four workers is still six tests
   * in flight and runs the suite noticeably faster than serial.
   */
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  // Firefox needs noticeably longer than the default 30s to start a page and lay out
  // KaTeX for the first time under parallel load. The symptom without this is a
  // `page.goto` timeout on whichever test happens to land on the slowest page, which
  // looks like a product flake and is not one.
  timeout: 60_000,

  use: {
    baseURL: 'http://127.0.0.1:4173',
    // Deterministic rendering: animations and caret blinking make screenshots
    // irreproducible.
    reducedMotion: 'reduce',
    deviceScaleFactor: 2,
    trace: 'retain-on-failure',
    navigationTimeout: 60_000,
  },

  projects: [
    {
      name: 'chromium',
      // The desktop entry spec loads a different bundle behind a stubbed IPC bridge, so
      // it is meaningless here and would otherwise run three more times, failing.
      testIgnore: /desktop-entry\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit',
      testIgnore: /desktop-entry\.spec\.ts/,
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'firefox',
      testIgnore: /desktop-entry\.spec\.ts/,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      // The desktop bundle, loaded with its Tauri IPC stubbed. Separate from the
      // harness projects because it is a different entry point with different wiring,
      // and because the entry is exactly what went untested for too long.
      name: 'desktop',
      // Only the entry-point spec. The other specs assume the browser harness's
      // in-memory library, which the desktop app does not have — it has a real one.
      testMatch: /desktop-entry\.spec\.ts/,
      // A different origin from the harness, so one spec file can load either bundle.
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:5174' },
    },
  ],

  // Two servers: the browser harness on 4173, and the desktop bundle on 5174. The
  // latter is started unconditionally, which costs a second or two per run, because
  // leaving the desktop entry unexercised has already cost a shipped bug.
  webServer: [
    {
      // `--host 127.0.0.1` is explicit because Vite's default `localhost` resolves to
      // IPv6 on some machines, and Playwright's readiness probe uses IPv4.
      command:
        'pnpm --filter @adnota/web preview --port 4173 --strictPort --host 127.0.0.1',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command:
        'pnpm --filter @adnota/desktop vite --port 5174 --strictPort --host 127.0.0.1',
      url: 'http://127.0.0.1:5174',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
