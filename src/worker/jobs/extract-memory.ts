import { getEvent, markEventProcessed, recordEvent } from "../../lib/events.js";
import { extractMessageText } from "../../lib/extract-text.js";
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
