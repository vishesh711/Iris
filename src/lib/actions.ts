import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { actions } from "../db/schema.js";
import { sendApprovalCard } from "./telegram-cards.js";
import { getToolDefinition } from "./tools/registry.js";
import { evaluateAction, isFailureCircuitTripped, type PolicyDecision } from "./tools/policy-gate.js";
import { deriveIdempotencyKey } from "./idempotency.js";
import { isLineageUntrusted } from "./untrusted-lineage.js";
import { finalizeUndoPayload, performUndo } from "./undo.js";
import { checkAutonomyDemotion, checkAutonomyPromotion, getAutonomyOverrideTier } from "./autonomy.js";

export type ActionRow = typeof actions.$inferSelect;

/**
 * The planner never calls a side-effecting tool directly — it proposes.
 * This writes the actions row and runs the deterministic policy gate.
 * Nothing executes here anymore (Milestone 6): a separate executor
 * process is the only thing that ever runs a tool handler, polling for
 * 'approved' rows, so a crash between decision and execution can't
 * silently lose or duplicate work. Tier 2 (or untrusted) decisions stay
 * 'proposed' for an explicit approve/reject, which sends a real
 * approval card. Idempotent: a second proposal with identical tool+args
 * returns the existing row instead of creating a duplicate.
 */
export async function proposeAction(params: {
  tool: string;
  args: Record<string, unknown>;
  rationale?: string;
  sourceEventId?: string;
  untrusted?: boolean;
}): Promise<{ action: ActionRow; decision: PolicyDecision }> {
  const definition = getToolDefinition(params.tool);

  // Untrusted lineage (invariant 7) overrides whatever the caller passed
  // — content derived from untrusted source material stays untrusted no
  // matter what the immediate caller believes about it.
  const lineageUntrusted = params.sourceEventId ? await isLineageUntrusted(params.sourceEventId) : false;
  const untrusted = (params.untrusted ?? false) || lineageUntrusted;

  const tierOverride = (await getAutonomyOverrideTier(params.tool)) ?? undefined;
  let decision = evaluateAction({ tool: params.tool, untrusted, tierOverride });
  if (decision === "approved" && (await isFailureCircuitTripped())) {
    decision = "queued";
  }

  const idempotencyKey = deriveIdempotencyKey(params.tool, params.args);

  const [existing] = await db.select().from(actions).where(eq(actions.idempotencyKey, idempotencyKey));
  if (existing) {
    return { action: existing, decision };
  }

  // Fail closed even in storage: an unrecognized tool still needs a tier
  // value for the not-null column, so it gets the most restrictive one.
  const tier = definition?.tier ?? 2;
  const status = decision === "approved" ? "approved" : decision === "queued" ? "proposed" : "rejected";

  const [row] = await db
    .insert(actions)
    .values({
      tool: params.tool,
      args: params.args,
      rationale: params.rationale,
      tier,
      status,
      sourceEventId: params.sourceEventId,
      untrusted,
      idempotencyKey,
      decidedAt: decision === "queued" ? undefined : new Date(),
    })
    .returning();

  if (decision === "queued") {
    await sendApprovalCard(row);
  }

  return { action: row, decision };
}

export async function executeAction(action: ActionRow): Promise<ActionRow> {
  const definition = getToolDefinition(action.tool);

  await db.update(actions).set({ status: "executing" }).where(eq(actions.id, action.id));

  try {
    if (!definition?.handler) {
      throw new Error(`No handler registered for tool: ${action.tool}`);
    }
    const result = await definition.handler(action.args as Record<string, unknown>);
    const undoPayload = finalizeUndoPayload(action.tool, result);
    const [updated] = await db
      .update(actions)
      .set({ status: "done", result: result ?? null, undoPayload, executedAt: new Date() })
      .where(eq(actions.id, action.id))
      .returning();
    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const [updated] = await db
      .update(actions)
      .set({ status: "failed", result: { error: message }, executedAt: new Date() })
      .where(eq(actions.id, action.id))
      .returning();
    return updated;
  }
}

export async function approveAction(actionId: string): Promise<ActionRow> {
  const [action] = await db.select().from(actions).where(eq(actions.id, actionId));
  if (!action) {
    throw new Error(`Action not found: ${actionId}`);
  }
  if (action.status !== "proposed") {
    return action;
  }

  // Marks it approved and stops there — the executor process picks up
  // 'approved' rows on its own poll and sends a follow-up once it's done,
  // rather than this call (which may be a Telegram callback handler with
  // its own timeout) waiting on the handler to finish.
  const [updated] = await db
    .update(actions)
    .set({ status: "approved", decidedAt: new Date() })
    .where(eq(actions.id, actionId))
    .returning();

  await checkAutonomyPromotion(action.tool);

  return updated;
}

export async function undoAction(actionId: string): Promise<ActionRow> {
  const [action] = await db.select().from(actions).where(eq(actions.id, actionId));
  if (!action) {
    throw new Error(`Action not found: ${actionId}`);
  }
  if (action.status !== "done") {
    throw new Error(`Cannot undo an action that isn't done (status: ${action.status}).`);
  }
  if (action.undoneAt) {
    return action;
  }

  await performUndo(action);

  const [updated] = await db.update(actions).set({ undoneAt: new Date() }).where(eq(actions.id, actionId)).returning();

  return updated;
}

export async function rejectAction(actionId: string): Promise<ActionRow> {
  const [action] = await db.select().from(actions).where(eq(actions.id, actionId));
  if (!action) {
    throw new Error(`Action not found: ${actionId}`);
  }
  if (action.status !== "proposed") {
    return action;
  }

  const [updated] = await db
    .update(actions)
    .set({ status: "rejected", decidedAt: new Date() })
    .where(eq(actions.id, actionId))
    .returning();

  await checkAutonomyDemotion(action.tool);

  return updated;
}
