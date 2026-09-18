import { getEvent, markEventProcessed, recordEvent } from "../../lib/events.js";
import { extractMessageText } from "../../lib/extract-text.js";
import { removeEmbedding } from "../../lib/embed-store.js";
import { extractMemoryCandidate } from "../../lib/memory-extraction.js";
import {
  bumpReinforcement,
  checkConflict,
  findActiveMemoriesBySubject,
  rememberFact,
  supersedeMemory,
} from "../../lib/memory.js";

export interface ExtractMemoryJobData {
  eventId: string;
  label: "fact" | "correction";
  traceId?: string;
}

export async function runExtractMemoryJob(data: ExtractMemoryJobData): Promise<void> {
  const event = await getEvent(data.eventId);
  if (!event) return;

  const text = extractMessageText(event.rawData);
  if (!text) {
    await markEventProcessed(event.id, { memoryExtracted: false, reason: "no-text" });
    return;
  }

  const candidate = await extractMemoryCandidate(text);
  if (!candidate) {
    await markEventProcessed(event.id, { memoryExtracted: false, reason: "nothing-to-store" });
    return;
  }

  // Every path below this point ends in a memory being created or
  // reinforced, so this event's content is now captured, with proper
  // supersession tracking, via memories.embedding - remove any raw-text
  // embedding for it (classify.ts's label-based check is best-effort,
  // not perfectly reliable, since the classifier itself can be
  // inconsistent on a near-duplicate message).
  await removeEmbedding("events", event.id);

  const existing = candidate.subject ? await findActiveMemoriesBySubject(candidate.subject) : [];

  // Nothing to compare against — no conflict-check model call needed, this
  // is trivially independent. Saves the one-call-per-write cost the PRD
  // flags as a real concern, without skipping any actual logic (an empty
  // candidate set makes checkConflict return exactly this same result).
  if (existing.length === 0) {
    const created = await rememberFact(candidate, { certainty: "asserted", sourceEventId: event.id });
    await markEventProcessed(event.id, {
      memoryExtracted: true,
      memoryId: created.id,
      relationship: "independent",
    });
    return;
  }

  const exactMatch = existing.find(
    (memory) => memory.statement.trim().toLowerCase() === candidate.statement.trim().toLowerCase()
  );
  if (exactMatch) {
    await bumpReinforcement(exactMatch.id);
    await markEventProcessed(event.id, {
      memoryExtracted: true,
      memoryId: exactMatch.id,
      relationship: "reinforced",
    });
    return;
  }

  const conflict = await checkConflict(
    candidate.statement,
    existing.map((memory) => memory.statement)
  );

  if (conflict.relationship === "contradicts" && conflict.contradictedIndex !== null) {
    const superseded = existing[conflict.contradictedIndex];
    await supersedeMemory(superseded.id);

    // The old statement is now superseded and must stop resurfacing
    // anywhere - including via any raw-event embedding a prior,
    // possibly inconsistent classification let through for the event(s)
    // that originally produced it.
    for (const oldEventId of superseded.sourceEventIds as string[]) {
      await removeEmbedding("events", oldEventId);
    }

    const created = await rememberFact(candidate, {
      certainty: "asserted",
      sourceEventId: event.id,
      supersedes: superseded.id,
    });
    await recordEvent({
      source: "telegram",
      type: "correction",
      rawData: { oldStatement: superseded.statement, newStatement: candidate.statement },
      metadata: {
        sourceEventId: event.id,
        oldMemoryId: superseded.id,
        newMemoryId: created.id,
        traceId: data.traceId,
      },
    });
    await markEventProcessed(event.id, {
      memoryExtracted: true,
      memoryId: created.id,
      relationship: "contradicts",
      supersededId: superseded.id,
    });
    return;
  }

  const created = await rememberFact(candidate, { certainty: "asserted", sourceEventId: event.id });
  await markEventProcessed(event.id, {
    memoryExtracted: true,
    memoryId: created.id,
    relationship: conflict.relationship,
  });
}
