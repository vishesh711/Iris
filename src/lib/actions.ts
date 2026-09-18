import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { actions } from "../db/schema.js";
import { getToolDefinition } from "./tools/registry.js";
import { evaluateAction, type PolicyDecision } from "./tools/policy-gate.js";
import { deriveIdempotencyKey } from "./idempotency.js";

export type ActionRow = typeof actions.$inferSelect;

/**
 * The planner never calls a side-effecting tool directly — it proposes.
 * This writes the actions row, runs the deterministic policy gate, and
 * — since there is no separate executor process until Milestone 6 —
 * synchronously executes tier 0/1 decisions here. Tier 2 (or untrusted)
 * decisions are left in 'proposed' status for an explicit approve/reject.
 * Idempotent: a second proposal with identical tool+args returns the
 * existing row instead of creating a duplicate.
 */
export async function proposeAction(params: {
  tool: string;
  args: Record<string, unknown>;
  rationale?: string;
  sourceEventId?: string;
  untrusted?: boolean;
}): Promise<{ action: ActionRow; decision: PolicyDecision }> {
  const definition = getToolDefinition(params.tool);
  const decision = evaluateAction({ tool: params.tool, untrusted: params.untrusted });
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
      untrusted: params.untrusted ?? false,
      idempotencyKey,
      decidedAt: decision === "queued" ? undefined : new Date(),
    })
    .returning();

  if (decision === "approved") {
    const executed = await executeAction(row);
    return { action: executed, decision };
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
    const [updated] = await db
      .update(actions)
      .set({ status: "done", result: result ?? null, executedAt: new Date() })
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

  const [updated] = await db
    .update(actions)
    .set({ status: "approved", decidedAt: new Date() })
    .where(eq(actions.id, actionId))
    .returning();

  return executeAction(updated);
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

  return updated;
}
