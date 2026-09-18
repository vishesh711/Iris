import { createHash } from "node:crypto";

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, val]) => [key, sortKeysDeep(val)]));
  }
  return value;
}

/**
 * Deterministic key derived from tool + arguments, independent of key
 * insertion order. Checked (and, once an executor exists, recorded) in the
 * same transaction as the result, so a crash between a successful
 * side-effecting call and the status write can't cause a resend on restart.
 */
export function deriveIdempotencyKey(tool: string, args: Record<string, unknown>): string {
  const payload = JSON.stringify({ tool, args: sortKeysDeep(args) });
  return createHash("sha256").update(payload).digest("hex");
}
