import "dotenv/config";
import "../lib/network.js";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { actions } from "../db/schema.js";
import { executeAction, type ActionRow } from "../lib/actions.js";
import { getAuthorizedClient } from "../lib/google/auth.js";
import { getDraft } from "../lib/google/gmail.js";
import { notifyOwner } from "../lib/notify.js";

const POLL_INTERVAL_MS = 3000;

/**
 * The hard idempotency case: if this process crashed after Gmail's send
 * call succeeded but before the DB commit marking it done, a blind retry
 * would send a real, duplicate email. A draft is consumed the moment it
 * sends — Gmail returns 404 for a sent draft's id — so checking whether
 * the draft still exists is definitive evidence the send already
 * happened, not a guess. Returns true if it fully handled the row
 * (either reconciled to done, or left alone pending manual review) —
 * false means it's safe to fall through to the generic reset-and-retry.
 */
async function reconcileStuckSendDraft(row: ActionRow): Promise<boolean> {
  try {
    const { draftId } = row.args as { draftId?: string };
    if (!draftId) return false;

    const auth = await getAuthorizedClient();
    const draft = await getDraft(auth, draftId);

    if (draft !== null) {
      return false; // draft still exists — the send never went through, safe to retry normally
    }

    await db
      .update(actions)
      .set({
        status: "done",
        result: { note: "Reconciled at executor startup: draft no longer existed, so the send had already succeeded before the crash." },
        executedAt: new Date(),
      })
      .where(eq(actions.id, row.id));
    console.warn(`Reconciled stuck action ${row.id}: draft already sent before crash — marked done without resending.`);
    return true;
  } catch (err) {
    // Can't determine the draft's state (auth/network issue) — never
    // guess in the direction that risks a duplicate send. Leave it in
    // 'executing' for manual inspection instead.
    console.error(`Could not reconcile stuck gmail.send_draft action ${row.id}; leaving as executing for manual review:`, err);
    return true;
  }
}

/**
 * A row stuck in 'executing' from a crash mid-run is put back to
 * 'approved' so the poll loop below picks it up again — reconciled once
 * at startup, before this process has executed anything itself, so any
 * 'executing' row found here is necessarily a leftover from a previous
 * run, never a race with this instance's own in-flight work. One tool
 * (gmail.send_draft) needs special handling first: see
 * reconcileStuckSendDraft above.
 */
async function reconcileStuckRows(): Promise<void> {
  const stuck = await db.select().from(actions).where(eq(actions.status, "executing"));
  for (const row of stuck) {
    if (row.tool === "gmail.send_draft" && (await reconcileStuckSendDraft(row))) {
      continue;
    }
    console.warn(`Reconciling stuck action ${row.id} (tool=${row.tool}) back to approved for re-pickup.`);
    await db.update(actions).set({ status: "approved" }).where(eq(actions.id, row.id));
  }
}

function describeResult(action: ActionRow): string {
  if (action.status !== "done") {
    const error = action.result && typeof action.result === "object" ? (action.result as { error?: string }).error : undefined;
    return `❌ ${action.tool} failed${error ? `: ${error}` : "."}`;
  }
  const result = action.result && typeof action.result === "object" ? (action.result as Record<string, unknown>) : {};
  if (action.tool === "memory.forget") {
    return `✅ Deleted ${(result.deletedCount as number | undefined) ?? 0} memories.`;
  }
  if (action.tool === "gmail.send_draft") {
    return `✅ Email sent to ${(result.recipient as string | undefined) ?? "recipient"}.`;
  }
  if (action.tool === "calendar.create_event") {
    return `✅ Calendar event "${(result.title as string | undefined) ?? "untitled"}" created.`;
  }
  return `✅ ${action.tool} completed.`;
}

/**
 * The only thing that ever runs a tool handler (Milestone 6): proposeAction
 * and approveAction only ever move a row to 'approved', this loop is what
 * actually executes it. Polls rather than a queue, since approvals are a
 * low-volume, human-paced event — a few seconds of latency is invisible.
 */
async function pollOnce(): Promise<void> {
  const pending = await db.select().from(actions).where(eq(actions.status, "approved"));
  for (const action of pending) {
    const executed = await executeAction(action);
    // The action's own status is already persisted at this point — a
    // failure to notify (e.g. a transient network blip reaching Telegram)
    // must never look like the action itself failed, and must never stop
    // the rest of this batch from being processed.
    try {
      await notifyOwner(describeResult(executed));
    } catch (err) {
      console.error(`Failed to send completion notification for action ${executed.id}:`, err);
    }
  }
}

async function main() {
  await reconcileStuckRows();
  console.log("Iris executor is running.");
  setInterval(() => {
    pollOnce().catch((err) => console.error("Executor poll failed:", err));
  }, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
