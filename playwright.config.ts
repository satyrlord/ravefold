import { defineConfig } from "@playwright/test";

if (process.env.RAVEFOLD_FULL_GATE !== "1") {
  throw new Error("Browser tests require npm run quality:full.");
}

export default defineConfig({
  testDir: "./tests/browser",
  outputDir: "tmp/browser-results",
  fullyParallel: false,
  workers: 1,
  maxFailures: 5,
  timeout: 30_000,
  reporter: [["list"], ["json", { outputFile: "tmp/browser-results.json" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    viewport: { width: 1440, height: 960 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /fallback\.spec\.ts/,
      use: {
        browserName: "chromium",
        channel: "chromium",
        launchOptions: { args: ["--enable-gpu"] },
      },
    },
    {
      name: "unsupported-browser",
      testMatch: /fallback\.spec\.ts/,
      use: { browserName: "firefox" },
    },
  ],
  webServer: {
    command: "npm run preview",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
