import os from "node:os";
import path from "node:path";
import { z } from "zod";

const optionalString = z
  .string()
  .trim()
  .transform((value) => value || undefined)
  .optional();

const workerConfigSchema = z.object({
  WEB_APP_URL: z.string().url().transform((value) => value.replace(/\/+$/, "")),
  WORKER_TOKEN: z.string().min(32).max(512),
  WORKER_ID: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9._-]+$/),
  POLL_INTERVAL_MS: z.coerce.number().int().min(1000).max(60000).default(5000),
  WORKER_RUN_ONCE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  CODEX_HOME: z.string().min(1).default(path.join(os.homedir(), ".codex")),
  CODEX_MODEL: optionalString,
  CODEX_REASONING_EFFORT: z
    .enum(["minimal", "low", "medium", "high", "xhigh"])
    .default("high"),
  WELINK_APP_NAME: z.string().min(1).default("com.huawei.cloud.welink"),
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export function getWorkerConfig(): WorkerConfig {
  return workerConfigSchema.parse(process.env);
}
