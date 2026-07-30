import { describe, expect, it } from "vitest";
import { randomToken, safeEqualHex, sha256 } from "@/lib/crypto";

describe("crypto helpers", () => {
  it("hashes stable input and compares digests in constant-size form", () => {
    const digest = sha256("worker-token");
    expect(digest).toHaveLength(64);
    expect(safeEqualHex(digest, sha256("worker-token"))).toBe(true);
    expect(safeEqualHex(digest, sha256("another-token"))).toBe(false);
    expect(safeEqualHex("not-hex", digest)).toBe(false);
  });

  it("creates URL-safe random tokens", () => {
    const token = randomToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
