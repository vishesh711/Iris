import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { actions } from "../db/schema.js";
import { executeAction, type ActionRow } from "../lib/actions.js";
import { notifyOwner } from "../lib/notify.js";

const POLL_INTERVAL_MS = 3000;

/**
 * A row stuck in 'executing' from a crash mid-run is put back to
 * 'approved' so the poll loop below picks it up again — reconciled once
 * at startup, before this process has executed anything itself, so any
 * 'executing' row found here is necessarily a leftover from a previous
 * run, never a race with this instance's own in-flight work.
 */
async function reconcileStuckRows(): Promise<void> {
  const stuck = await db.select().from(actions).where(eq(actions.status, "executing"));
  for (const row of stuck) {
    console.warn(`Reconciling stuck action ${row.id} (tool=${row.tool}) back to approved for re-pickup.`);
    await db.update(actions).set({ status: "approved" }).where(eq(actions.id, row.id));
  }
}

function describeResult(action: ActionRow): string {
  if (action.status !== "done") {
    const error = action.result && typeof action.result === "object" ? (action.result as { error?: string }).error : undefined;
    return `❌ ${action.tool} failed${error ? `: ${error}` : "."}`;
  }
  if (action.tool === "memory.forget") {
    const deletedCount =
      action.result && typeof action.result === "object" ? (action.result as { deletedCount?: number }).deletedCount : undefined;
    return `✅ Deleted ${deletedCount ?? 0} memories.`;
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
    await notifyOwner(describeResult(executed));
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
