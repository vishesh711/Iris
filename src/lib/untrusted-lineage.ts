import { getEvent } from "./events.js";

const MAX_DEPTH = 10;

/**
 * Walks source_event_id back through the chain (invariant 7): if any
 * ancestor event was tagged untrusted at ingest time (Gmail content,
 * since Milestone 3), the proposal it fed must be treated as untrusted
 * regardless of what tier the tool is or what the caller passed - a
 * tool being "safe" doesn't make model-visible untrusted content safe
 * to act on unsupervised. Bounded depth and a visited set guard against
 * a corrupt or cyclic chain looping forever.
 */
export async function isLineageUntrusted(eventId: string): Promise<boolean> {
  let currentId: string | undefined = eventId;
  const visited = new Set<string>();

  for (let depth = 0; currentId && depth < MAX_DEPTH; depth++) {
    if (visited.has(currentId)) break;
    visited.add(currentId);

    const event = await getEvent(currentId);
    if (!event) break;

    const metadata = event.metadata as Record<string, unknown> | null;
    if (metadata?.untrusted === true) {
      return true;
    }

    currentId = typeof metadata?.sourceEventId === "string" ? metadata.sourceEventId : undefined;
  }

  return false;
}
