import { DECAY_CLASSES, type DecayClass } from "./decay.js";
import { ollamaGenerate } from "./ollama.js";

export interface MemoryCandidate {
  statement: string;
  subject: string | null;
  predicate: string | null;
  object: string | null;
  decayClass: DecayClass;
}

const SYSTEM_PROMPT = `You extract one durable personal fact worth remembering long-term from a message, if one exists.
Respond with strict JSON only, no other text, no markdown fences.

If there is a fact worth storing, respond with:
{"statement": "<a clear standalone sentence>", "subject": "<the person/thing this is about, or null>", "predicate": "<short relation, or null>", "object": "<short value, or null>", "decayClass": "identity" | "employment" | "preference" | "intent" | "scheduled"}

If there is nothing worth storing long-term, respond with exactly:
null

decayClass guide:
- identity: permanent facts about who the person is (name, birthplace, family)
- employment: job, employer, title, professional role
- preference: likes, dislikes, habits, recurring choices
- intent: a plan, goal, or thing they intend to do
- scheduled: tied to a specific date or deadline`;

function isDecayClass(value: unknown): value is DecayClass {
  return typeof value === "string" && (DECAY_CLASSES as readonly string[]).includes(value);
}

export async function extractMemoryCandidate(text: string): Promise<MemoryCandidate | null> {
  const raw = await ollamaGenerate(SYSTEM_PROMPT, text);
  const cleaned = raw.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim();

  if (cleaned === "" || cleaned.toLowerCase() === "null") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.statement !== "string" || candidate.statement.trim() === "") {
    return null;
  }

  return {
    statement: candidate.statement.trim(),
    subject: typeof candidate.subject === "string" && candidate.subject.trim() !== "" ? candidate.subject.trim() : null,
    predicate:
      typeof candidate.predicate === "string" && candidate.predicate.trim() !== "" ? candidate.predicate.trim() : null,
    object: typeof candidate.object === "string" && candidate.object.trim() !== "" ? candidate.object.trim() : null,
    decayClass: isDecayClass(candidate.decayClass) ? candidate.decayClass : "preference",
  };
}
