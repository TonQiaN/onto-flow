import { describe, expect, it } from "vitest";
import {
  createMessageSchema,
  loginSchema,
  workerIdentitySchema,
} from "@/lib/validation";

describe("request validation", () => {
  it("accepts the seeded test message", () => {
    expect(
      createMessageSchema.parse({
        recipient: " 付方圆 ",
        message: " 这是一条测试消息 ",
      }),
    ).toEqual({
      recipient: "付方圆",
      message: "这是一条测试消息",
    });
  });

  it("rejects empty or oversized messages", () => {
    expect(
      createMessageSchema.safeParse({ recipient: "付方圆", message: " " }).success,
    ).toBe(false);
    expect(
      createMessageSchema.safeParse({
        recipient: "付方圆",
        message: "x".repeat(2001),
      }).success,
    ).toBe(false);
  });

  it("constrains machine identity and login size", () => {
    expect(workerIdentitySchema.safeParse({ workerId: "mac-1" }).success).toBe(
      true,
    );
    expect(
      workerIdentitySchema.safeParse({ workerId: "../unsafe" }).success,
    ).toBe(false);
    expect(
      loginSchema.safeParse({ username: "admin", password: "x".repeat(257) })
        .success,
    ).toBe(false);
  });
});
