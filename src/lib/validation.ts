import { z } from "zod";
import { isAllowedRecipient } from "@/lib/recipients";

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(256),
});

export const createMessageSchema = z.object({
  recipient: z
    .string()
    .trim()
    .refine(isAllowedRecipient, "Recipient is not allowed."),
  message: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .refine((value) => !/[\r\n]/.test(value), "Message must be single-line."),
});

export const manualReviewResolutionSchema = z.discriminatedUnion("resolution", [
  z.object({
    resolution: z.literal("sent"),
    screenshotDataUrl: z.string().min(1).max(12_000_000),
  }),
  z.object({
    resolution: z.literal("not_sent"),
  }),
]);

export const workerIdentitySchema = z.object({
  workerId: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9._-]+$/),
  version: z.string().trim().max(80).optional(),
});

export const workerLeaseSchema = workerIdentitySchema.extend({
  leaseToken: z.string().min(32).max(512),
});

export const workerFailureSchema = workerLeaseSchema.extend({
  certainty: z.enum(["not_sent", "uncertain"]),
  error: z.string().trim().min(1).max(2000),
  codexThreadId: z.string().trim().max(200).optional(),
});
