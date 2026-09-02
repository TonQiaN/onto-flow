import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  // html 报告只落盘不自动打开：CI 失败时 playwright-report/ 随 test-results/ 一起上传
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3592",
    trace: "retain-on-failure",
  },
  // Next 16 不允许同一目录起第二个 dev server，因此固定复用 3592 上的那个
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3592",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
