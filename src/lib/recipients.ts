export const ALLOWED_RECIPIENTS = ["付方圆", "成雨函"] as const;

export type AllowedRecipient = (typeof ALLOWED_RECIPIENTS)[number];

export function isAllowedRecipient(value: string): value is AllowedRecipient {
  return ALLOWED_RECIPIENTS.some((recipient) => recipient === value);
}
