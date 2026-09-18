import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { syncState } from "../db/schema.js";

export type SyncStateRow = typeof syncState.$inferSelect;

export async function getSyncState(key: string): Promise<SyncStateRow | undefined> {
  const [row] = await db.select().from(syncState).where(eq(syncState.key, key));
  return row;
}

export async function recordSyncSuccess(key: string, value: unknown): Promise<void> {
  await db
    .insert(syncState)
    .values({ key, value, lastSyncedAt: new Date(), lastError: null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: syncState.key,
      set: { value, lastSyncedAt: new Date(), lastError: null, updatedAt: new Date() },
    });
}

export async function recordSyncFailure(key: string, error: string): Promise<void> {
  const existing = await getSyncState(key);
  await db
    .insert(syncState)
    .values({ key, value: existing?.value ?? null, lastError: error, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: syncState.key,
      set: { lastError: error, updatedAt: new Date() },
    });
}

/**
 * Unlike recordSyncFailure, this clears the stored watermark itself, not
 * just the error message — for cases like an expired Gmail historyId or
 * Calendar syncToken, where the stored value is actively wrong and the
 * next poll needs to fall back to a full backfill rather than retry the
 * same bad watermark forever.
 */
export async function resetSyncState(key: string, error: string): Promise<void> {
  await db
    .insert(syncState)
    .values({ key, value: null, lastError: error, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: syncState.key,
      set: { value: null, lastError: error, updatedAt: new Date() },
    });
}
