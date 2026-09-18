export type FailureClass = "retryable" | "auth" | "rate_limit" | "invalid_input" | "provider_failure" | "internal_failure";

const NETWORK_ERROR_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE"]);

export function extractHttpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const record = err as Record<string, unknown>;

  // response.status is the authoritative field for real gaxios/Google API
  // errors; top-level status/code are fallbacks for other error shapes.
  const response = record.response;
  if (response && typeof response === "object" && typeof (response as Record<string, unknown>).status === "number") {
    return (response as Record<string, unknown>).status as number;
  }

  if (typeof record.status === "number") return record.status;
  if (typeof record.code === "number") return record.code;

  return undefined;
}

function isNetworkErrorCode(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as Record<string, unknown>).code;
  return typeof code === "string" && NETWORK_ERROR_CODES.has(code);
}

/**
 * Only `retryable` and `auth` are ever acted on automatically — retryable
 * gets exponential backoff, auth surfaces to Telegram immediately (an
 * expired token otherwise stops ingest silently). Everything else is
 * logged to sync_state.last_error for the debug UI, not retried blindly.
 */
export function classifyGoogleError(err: unknown): FailureClass {
  const status = extractHttpStatus(err);

  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (typeof status === "number" && status >= 500) return "provider_failure";
  if (typeof status === "number" && status >= 400) return "invalid_input";
  if (isNetworkErrorCode(err)) return "retryable";

  return "internal_failure";
}
