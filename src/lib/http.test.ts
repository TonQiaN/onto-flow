import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { parseServerConfig } from "@/lib/env";
import { clientIp } from "@/lib/http";

beforeEach(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATA_DIR: ".data-test",
    NEXT_PUBLIC_BASE_PATH: "",
    PUBLIC_APP_URL: "http://localhost:3000",
    SESSION_COOKIE_SECURE: "false",
    TRUST_PROXY_HEADERS: "false",
    TRUSTED_ORIGINS: "http://localhost:3000",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD_HASH:
      "$2b$12$TU5.nAhMgEIn9awk6Vx.Tu3xPuTlFQ2ctdTOLY8SOTJJuY77OV.Ey",
    WORKER_TOKEN_SHA256: "a".repeat(64),
    WORKER_LEASE_SECONDS: "60",
    SCREENSHOT_MAX_BYTES: "8388608",
    SCREENSHOT_MAX_WIDTH: "4096",
    SCREENSHOT_MAX_HEIGHT: "4096",
    SCREENSHOT_MAX_PIXELS: "16777216",
  });
});

describe("trusted client address handling", () => {
  it("ignores spoofable forwarding headers unless proxy trust is enabled", () => {
    const request = new NextRequest("http://localhost/api/auth/login", {
      headers: {
        "x-forwarded-for": "203.0.113.7",
        "x-real-ip": "203.0.113.8",
      },
    });
    expect(clientIp(request)).toBe("direct-client");
  });

  it("uses only a valid X-Real-IP supplied by a trusted proxy", () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    const request = new NextRequest("http://localhost/api/auth/login", {
      headers: {
        "x-forwarded-for": "203.0.113.7",
        "x-real-ip": "198.51.100.9",
      },
    });
    expect(clientIp(request)).toBe("198.51.100.9");

    const invalid = new NextRequest("http://localhost/api/auth/login", {
      headers: {
        "x-real-ip": "198.51.100.9, 203.0.113.7",
      },
    });
    expect(clientIp(invalid)).toBe("unknown-proxy-client");
  });
});

describe("production transport configuration", () => {
  it("allows loopback HTTP for the private experiment entry point", () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      PUBLIC_APP_URL: "http://127.0.0.1:4310/codex-experiment",
      SESSION_COOKIE_SECURE: "false",
    });
    expect(parseServerConfig(process.env).PUBLIC_APP_URL).toBe(
      "http://127.0.0.1:4310/codex-experiment",
    );
  });

  it("requires HTTPS and secure cookies for a non-loopback production URL", () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      PUBLIC_APP_URL: "http://example.com/codex-experiment",
      SESSION_COOKIE_SECURE: "false",
    });
    expect(() => parseServerConfig(process.env)).toThrow(/PUBLIC_APP_URL/);

    Object.assign(process.env, {
      PUBLIC_APP_URL: "https://example.com/codex-experiment",
      SESSION_COOKIE_SECURE: "false",
    });
    expect(() => parseServerConfig(process.env)).toThrow(
      /SESSION_COOKIE_SECURE/,
    );
  });

  it("accepts the authenticated public HTTPS endpoint with secure cookies", () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      PUBLIC_APP_URL:
        "https://codex.82.156.249.86.nip.io/codex-experiment",
      SESSION_COOKIE_SECURE: "true",
      TRUST_PROXY_HEADERS: "true",
      TRUSTED_ORIGINS: "https://codex.82.156.249.86.nip.io",
    });

    const config = parseServerConfig(process.env);
    expect(config.PUBLIC_APP_URL).toBe(
      "https://codex.82.156.249.86.nip.io/codex-experiment",
    );
    expect(config.SESSION_COOKIE_SECURE).toBe(true);
    expect(config.TRUST_PROXY_HEADERS).toBe(true);
  });
});
