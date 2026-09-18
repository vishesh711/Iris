import { and, eq, gte } from "drizzle-orm";
import { db } from "../../db/client.js";
import { actions } from "../../db/schema.js";
import { getToolDefinition } from "./registry.js";

export type PolicyDecision = "approved" | "queued" | "denied";

/**
 * Deterministic code, never a model call. The kill switch drains
 * everything to the queue regardless of tier — an emergency full stop
 * for automatic execution, not a normal operating mode. Tier 0/1
 * auto-approve, tier 2 queues for a tap, untrusted lineage forces the
 * queue regardless of tier. Any failure to evaluate — an unregistered
 * tool, a malformed tier — must resolve to "denied", never a permissive
 * default. This is the one place where the model must not be able to
 * reason its way to "this one is safe."
 */
/**
 * tierOverride (Milestone 7's autonomy ladder) substitutes for the
 * registry's static tier when the person has explicitly promoted a tool
 * to auto-approve — it never widens what untrusted lineage or the kill
 * switch already force, both of which are still checked first.
 */
export function evaluateAction(params: { tool: string; untrusted?: boolean; tierOverride?: number }): PolicyDecision {
  try {
    if (process.env.IRIS_KILL_SWITCH === "true") {
      return "queued";
    }

    const definition = getToolDefinition(params.tool);
    if (!definition) {
      throw new Error(`Unknown tool: ${params.tool}`);
    }

    if (params.untrusted) {
      return "queued";
    }

    const tier = params.tierOverride ?? definition.tier;

    if (tier === 2) {
      return "queued";
    }

    if (tier === 0 || tier === 1) {
      return "approved";
    }

    throw new Error(`Unrecognized tier for tool ${params.tool}: ${tier}`);
  } catch {
    return "denied";
  }
}

const FAILURE_WINDOW_MS = 60 * 60 * 1000;
const FAILURE_THRESHOLD = 3;

/**
 * A burst of recent failures halts further automatic execution: an
 * auto-approved decision falls back to queued for a manual look instead
 * of continuing to auto-run into whatever is causing them to fail. A
 * separate, DB-backed check rather than folded into evaluateAction
 * above, so that function stays a pure, synchronous, easily-tested
 * decision table — this one is deliberately the only place policy
 * depends on I/O.
 */
export async function isFailureCircuitTripped(): Promise<boolean> {
  const since = new Date(Date.now() - FAILURE_WINDOW_MS);
  const recentFailures = await db
    .select({ id: actions.id })
    .from(actions)
    .where(and(eq(actions.status, "failed"), gte(actions.executedAt, since)));
  return recentFailures.length >= FAILURE_THRESHOLD;
}
