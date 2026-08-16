import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  workers: 1,
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
