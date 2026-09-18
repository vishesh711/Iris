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
{"statement": "<a clear standalone sentence>", "subject": "<see subject rule below>", "predicate": "<short relation, or null>", "object": "<short value, or null>", "decayClass": "identity" | "employment" | "preference" | "intent" | "scheduled"}

Subject rule: subject identifies who/what the fact is about, and is what
later facts get compared against to detect contradictions — it should
almost never be null. If the fact is about the person sending the
message (their own preferences, identity, job, plans), use exactly
"user". Only use a different subject when the fact is clearly about
someone or something else (e.g. "user's manager", "Acme Corp"). Use
null only if there is truly no identifiable subject.

A message that corrects or updates something previously said is still a
fact worth storing — extract the NEW value as the statement, exactly as
you would for a first-time statement. Never respond null just because
the message sounds like a correction ("actually...", "...now", "not
... anymore").

If there is nothing worth storing long-term, respond with exactly:
null

decayClass guide:
- identity: permanent facts about who the person is (name, birthplace, family)
- employment: job, employer, title, professional role
- preference: likes, dislikes, habits, recurring choices
- intent: a plan, goal, or thing they intend to do
- scheduled: tied to a specific date or deadline

Examples:
"My favorite coffee order is a flat white." -> {"statement": "Favorite coffee order is a flat white.", "subject": "user", "predicate": "prefers", "object": "flat white", "decayClass": "preference"}
"I live in Philadelphia now." -> {"statement": "Lives in Philadelphia.", "subject": "user", "predicate": "lives in", "object": "Philadelphia", "decayClass": "identity"}
"My manager's name is Priya." -> {"statement": "Manager's name is Priya.", "subject": "user's manager", "predicate": "name", "object": "Priya", "decayClass": "employment"}
"Actually, I moved to Boston, not Philadelphia." -> {"statement": "Lives in Boston.", "subject": "user", "predicate": "lives in", "object": "Boston", "decayClass": "identity"}
"Actually my favorite coffee order is a cortado now." -> {"statement": "Favorite coffee order is a cortado.", "subject": "user", "predicate": "prefers", "object": "cortado", "decayClass": "preference"}`;

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
