import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATA_DIR: z.string().min(1).default(".data"),
  NEXT_PUBLIC_BASE_PATH: z.string().default(""),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  SESSION_COOKIE_SECURE: booleanString,
  TRUST_PROXY_HEADERS: booleanString,
  TRUSTED_ORIGINS: z.string().default("http://localhost:3000"),
  ADMIN_USERNAME: z.string().min(1).max(80),
  ADMIN_PASSWORD_HASH: z
    .string()
    .regex(/^\$2[aby]\$\d{2}\$.{53}$/, "ADMIN_PASSWORD_HASH must be bcrypt"),
  WORKER_TOKEN_SHA256: z
    .string()
    .regex(/^[a-f0-9]{64}$/, "WORKER_TOKEN_SHA256 must be SHA-256 hex"),
  WORKER_LEASE_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  SCREENSHOT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(8 * 1024 * 1024)
    .default(8 * 1024 * 1024),
  SCREENSHOT_MAX_WIDTH: z.coerce.number().int().min(1).max(8192).default(4096),
  SCREENSHOT_MAX_HEIGHT: z.coerce.number().int().min(1).max(8192).default(4096),
  SCREENSHOT_MAX_PIXELS: z.coerce
    .number()
    .int()
    .min(1)
    .max(32 * 1024 * 1024)
    .default(16 * 1024 * 1024),
}).superRefine((config, context) => {
  if (config.NODE_ENV !== "production") return;

  const publicUrl = new URL(config.PUBLIC_APP_URL);
  const isLoopback =
    publicUrl.hostname === "localhost" ||
    publicUrl.hostname === "[::1]" ||
    publicUrl.hostname.startsWith("127.");
  if (publicUrl.protocol !== "https:" && !isLoopback) {
    context.addIssue({
      code: "custom",
      path: ["PUBLIC_APP_URL"],
      message: "PUBLIC_APP_URL must use HTTPS in production unless it is loopback",
    });
  }
  if (publicUrl.protocol === "https:" && !config.SESSION_COOKIE_SECURE) {
    context.addIssue({
      code: "custom",
      path: ["SESSION_COOKIE_SECURE"],
      message: "SESSION_COOKIE_SECURE must be true for production HTTPS",
    });
  }
});

export type ServerConfig = z.infer<typeof serverSchema>;

let cachedConfig: ServerConfig | undefined;

export function parseServerConfig(
  environment: NodeJS.ProcessEnv,
): ServerConfig {
  return serverSchema.parse(environment);
}

export function getServerConfig(): ServerConfig {
  if (process.env.NODE_ENV === "test") {
    return parseServerConfig(process.env);
  }

  cachedConfig ??= parseServerConfig(process.env);
  return cachedConfig;
}

export function normalizedBasePath(): string {
  const value = process.env.NEXT_PUBLIC_BASE_PATH?.trim() ?? "";
  if (!value || value === "/") return "";
  return `/${value.replace(/^\/+|\/+$/g, "")}`;
}

export function trustedOrigins(): Set<string> {
  const config = getServerConfig();
  const origins = config.TRUSTED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  origins.push(new URL(config.PUBLIC_APP_URL).origin);
  return new Set(origins);
}
