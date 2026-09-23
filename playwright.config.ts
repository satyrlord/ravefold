import { defineConfig } from "@playwright/test";

if (process.env.RAVEFOLD_FULL_GATE !== "1") {
  throw new Error("Browser tests require npm run quality:full.");
}

const testPort = Number(process.env.RAVEFOLD_TEST_PORT ?? "4173");
if (!Number.isInteger(testPort) || testPort < 1 || testPort > 65_535) {
  throw new Error("RAVEFOLD_TEST_PORT must be a valid port number.");
}
const testUrl = `http://127.0.0.1:${testPort}`;

export default defineConfig({
  testDir: "./tests/browser",
  outputDir: "tmp/browser-results",
  fullyParallel: false,
  workers: 1,
  maxFailures: 5,
  timeout: 30_000,
  reporter: [["list"], ["json", { outputFile: "tmp/browser-results.json" }]],
  use: {
    baseURL: testUrl,
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
      use: {
        browserName: "chromium",
        channel: "chromium",
        launchOptions: { args: ["--enable-gpu"] },
      },
    },
  ],
  webServer: {
    command: `node node_modules/vite/bin/vite.js preview --port ${testPort}`,
    url: testUrl,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
