import { getToolDefinition } from "./registry.js";

export type PolicyDecision = "approved" | "queued" | "denied";

/**
 * Deterministic code, never a model call. Tier 0/1 auto-approve, tier 2
 * queues for a tap, untrusted lineage forces the queue regardless of tier.
 * Any failure to evaluate — an unregistered tool, a malformed tier — must
 * resolve to "denied", never a permissive default. This is the one place
 * where the model must not be able to reason its way to "this one is safe."
 */
export function evaluateAction(params: { tool: string; untrusted?: boolean }): PolicyDecision {
  try {
    const definition = getToolDefinition(params.tool);
    if (!definition) {
      throw new Error(`Unknown tool: ${params.tool}`);
    }

    if (params.untrusted) {
      return "queued";
    }

    if (definition.tier === 2) {
      return "queued";
    }

    if (definition.tier === 0 || definition.tier === 1) {
      return "approved";
    }

    throw new Error(`Unrecognized tier for tool ${params.tool}: ${definition.tier}`);
  } catch {
    return "denied";
  }
}
