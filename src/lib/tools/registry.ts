import { executeForget } from "../memory.js";

// Every tool's tier is declared here, not inferred at runtime by a model.
// Tier 0: read, automatic. Tier 1: reversible/private write, automatic.
// Tier 2: external or irreversible, requires approval.
export type ToolTier = 0 | 1 | 2;

export interface ToolDefinition {
  name: string;
  tier: ToolTier;
  description: string;
  handler?: (args: Record<string, unknown>) => Promise<unknown>;
}

const registry = new Map<string, ToolDefinition>();

function register(def: ToolDefinition): void {
  registry.set(def.name, def);
}

register({
  name: "memory.search",
  tier: 0,
  description: "Search stored memories. Read-only, no side effects.",
});

register({
  name: "memory.remember",
  tier: 1,
  description: "Store a new memory. Reversible (superseded, not destroyed) and private.",
});

register({
  name: "memory.forget",
  tier: 2,
  description: "Hard-delete memories matching a target. Irreversible — requires approval.",
  handler: async (args) => executeForget(args.matchedIds as string[]),
});

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return registry.get(name);
}

export function listTools(): ToolDefinition[] {
  return [...registry.values()];
}
