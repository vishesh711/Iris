import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { emails } from "../../db/schema.js";
import { recordEvent } from "../../lib/events.js";
import { getAuthorizedClient } from "../../lib/google/auth.js";
import { classifyGoogleError, extractHttpStatus } from "../../lib/google/errors.js";
import { getCurrentHistoryId, getMessage, listInitialMessageIds, listMessageIdsSince } from "../../lib/google/gmail.js";
import { notifyOwner } from "../../lib/notify.js";
import { getSyncState, recordSyncFailure, recordSyncSuccess, resetSyncState } from "../../lib/sync-state.js";
import { getBoss, QUEUES } from "../../lib/queue.js";
import type { ExtractEntityJobData } from "./extract-entities.js";

const SYNC_KEY = "gmail_history_id";

interface GmailSyncValue {
  historyId?: string;
}

export async function runIngestGmailJob(): Promise<void> {
  let auth;
  try {
    auth = await getAuthorizedClient();
  } catch (err) {
    // Not configured yet (no stored refresh token) — nothing to poll.
    console.error("Gmail ingest skipped:", err instanceof Error ? err.message : err);
    return;
  }

  const state = await getSyncState(SYNC_KEY);
  const storedHistoryId = (state?.value as GmailSyncValue | null)?.historyId;

  let messageIds: string[];
  let newHistoryId: string | null;

  try {
    if (storedHistoryId) {
      const result = await listMessageIdsSince(auth, storedHistoryId);
      messageIds = result.messageIds;
      newHistoryId = result.historyId ?? storedHistoryId;
    } else {
      messageIds = await listInitialMessageIds(auth);
      newHistoryId = await getCurrentHistoryId(auth);
    }
  } catch (err) {
    await handleIngestError(err, storedHistoryId);
    return;
  }

  for (const messageId of messageIds) {
    try {
      await ingestOneMessage(auth, messageId);
    } catch (err) {
      // One bad message shouldn't abort the whole batch — log and move on;
      // it'll be retried on the next poll since the watermark only
      // advances after this loop completes successfully.
      console.error(`Gmail ingest: failed to process message ${messageId}`, err);
    }
  }

  if (newHistoryId) {
    await recordSyncSuccess(SYNC_KEY, { historyId: newHistoryId } satisfies GmailSyncValue);
  }
}

async function ingestOneMessage(auth: Awaited<ReturnType<typeof getAuthorizedClient>>, messageId: string): Promise<void> {
  const parsed = await getMessage(auth, messageId);

  const [row] = await db
    .insert(emails)
    .values({
      messageId: parsed.messageId,
      threadId: parsed.threadId,
      fromAddress: parsed.fromAddress,
      fromName: parsed.fromName,
      toAddresses: parsed.toAddresses,
      subject: parsed.subject,
      snippet: parsed.snippet,
      bodyText: parsed.bodyText,
      labels: parsed.labels,
      receivedAt: parsed.receivedAt,
      raw: parsed.raw,
    })
    .onConflictDoNothing({ target: emails.messageId })
    .returning();

  // Gmail's history API redelivers constantly; a conflict here just means
  // an earlier poll already ingested this message, nothing left to do.
  if (!row) return;

  // Every Gmail-sourced event is tagged untrusted at the moment it's
  // ingested — this can't be reconstructed later, and Milestone 6's
  // policy gate depends on it existing from day one.
  await recordEvent({
    source: "gmail",
    type: "email",
    rawData: { messageId: parsed.messageId, subject: parsed.subject, from: parsed.fromAddress },
    metadata: { untrusted: true, emailId: row.id },
  });

  const boss = await getBoss();
  await boss.send(QUEUES.extractEntities, { emailId: row.id } satisfies ExtractEntityJobData);
}

async function handleIngestError(err: unknown, hadStoredHistoryId: string | undefined): Promise<void> {
  const failureClass = classifyGoogleError(err);
  const message = err instanceof Error ? err.message : String(err);
  const status = extractHttpStatus(err);

  // Gmail doesn't guarantee history past ~1 week; a 404 on an incremental
  // poll means the watermark expired, not that anything is actually
  // broken. Clear it so the next run does a fresh backfill instead of
  // retrying the same stale historyId forever.
  if (status === 404 && hadStoredHistoryId) {
    await resetSyncState(SYNC_KEY, `historyId expired, will re-backfill: ${message}`);
    return;
  }

  // Notify only on the transition into a failing state, not on every poll
  // while it stays broken — recordSyncSuccess clears lastError once ingest
  // recovers, so the next real failure will notify again.
  const alreadyFailing = Boolean((await getSyncState(SYNC_KEY))?.lastError);
  await recordSyncFailure(SYNC_KEY, message);

  if (failureClass === "auth" && !alreadyFailing) {
    await notifyOwner(`⚠️ Iris lost access to Gmail (auth error). Run \`npm run google:auth-setup\` again.\n\n${message}`);
  }
}
