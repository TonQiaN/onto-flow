import { hash } from "bcryptjs";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const webEnvPath = path.join(root, ".env.local");
const workerEnvPath = path.join(root, ".env.worker.local");
const credentialDirectory = path.join(root, ".data");
const credentialPath = path.join(credentialDirectory, "admin-credentials.txt");

async function assertMissing(filename: string) {
  try {
    const handle = await open(filename, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${path.basename(filename)} already exists; refusing to overwrite it.`);
    }
    throw error;
  }
}

const adminUsername = "admin";
const adminPassword = `Wl-${randomBytes(15).toString("base64url")}`;
const adminPasswordHash = await hash(adminPassword, 12);
const workerToken = randomBytes(32).toString("base64url");
const workerTokenHash = createHash("sha256")
  .update(workerToken)
  .digest("hex");

await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
await Promise.all([
  assertMissing(webEnvPath),
  assertMissing(workerEnvPath),
  assertMissing(credentialPath),
]);

await Promise.all([
  writeFile(
    webEnvPath,
    [
      "NODE_ENV=development",
      "DATA_DIR=.data",
      "NEXT_PUBLIC_BASE_PATH=",
      "PUBLIC_APP_URL=http://127.0.0.1:3000",
      "SESSION_COOKIE_SECURE=false",
      "TRUSTED_ORIGINS=http://127.0.0.1:3000,http://localhost:3000",
      `ADMIN_USERNAME=${adminUsername}`,
      `ADMIN_PASSWORD_HASH=${adminPasswordHash.replaceAll("$", "\\$")}`,
      `WORKER_TOKEN_SHA256=${workerTokenHash}`,
      "WORKER_LEASE_SECONDS=600",
      "SCREENSHOT_MAX_BYTES=8388608",
      "",
    ].join("\n"),
    { mode: 0o600 },
  ),
  writeFile(
    workerEnvPath,
    [
      "WEB_APP_URL=http://127.0.0.1:3000",
      `WORKER_TOKEN=${workerToken}`,
      "WORKER_ID=fangyuanfu-mac",
      "POLL_INTERVAL_MS=5000",
      "WORKER_RUN_ONCE=false",
      `CODEX_HOME=${path.join(process.env.HOME ?? "", ".codex")}`,
      "CODEX_MODEL=",
      "CODEX_REASONING_EFFORT=high",
      "WELINK_APP_NAME=com.huawei.cloud.welink",
      "",
    ].join("\n"),
    { mode: 0o600 },
  ),
  writeFile(
    credentialPath,
    [
      "WeLink Message Lab administrator",
      `username=${adminUsername}`,
      `password=${adminPassword}`,
      "",
      "This file is local-only and ignored by Git.",
      "",
    ].join("\n"),
    { mode: 0o600 },
  ),
]);

console.log("Created .env.local, .env.worker.local, and .data/admin-credentials.txt.");
