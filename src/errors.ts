/**
 * Every failure the kit reports is a ByokError with a stable `code` and a
 * message written for the visitor, so a site can show `error.message` as-is.
 */
export type ByokErrorCode =
  | "no_key"
  | "invalid_key"
  | "subscription_token"
  | "admin_key"
  | "model_not_allowed"
  | "budget_exceeded"
  | "bad_config"
  | "invalid_request"
  | "auth_failed"
  | "no_credits"
  | "permission_denied"
  | "rate_limited"
  | "overloaded"
  | "request_rejected"
  | "network"
  | "aborted";

export class ByokError extends Error {
  readonly code: ByokErrorCode;

  constructor(code: ByokErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ByokError";
    this.code = code;
  }
}

/** Replace every occurrence of the key in a string, so error text can never echo it. */
export function redact(text: string, key: string | null): string {
  if (!key) return text;
  return text.split(key).join("[redacted key]");
}
