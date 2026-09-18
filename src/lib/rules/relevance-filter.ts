import { ollamaGenerate } from "../ollama.js";
import type { RuleCandidate } from "./types.js";

export interface SelectedNudge {
  candidate: RuleCandidate;
  title: string;
  body: string;
}

const SYSTEM_PROMPT = `You review candidate nudges for a personal agent and decide which, if any, are actually worth interrupting the person about right now. Most days most candidates are NOT worth surfacing - be selective.

A candidate is only worth surfacing when the ball is genuinely in the person's court - the other party is waiting on a reply, a decision, or an action FROM the person. Never select a candidate that is any of the following, even if it looks superficially relevant:
- an explicit rejection or "we've decided to move forward with other candidates" - the thread is closed, there is nothing to follow up on
- an automated acknowledgment of receipt ("we received your application", "our team is reviewing it") where THEY said they will get back to the person, not the other way around
- a one-time passcode, verification code, or other automated security email - these are not a person waiting for a reply, and are almost always already expired
- a purely informational update with no request or open question attached

Only select a candidate that clearly asked the person a question, requested a document or a decision, proposed times to confirm, or otherwise needs the person to act - and that a reasonable person would actually want to be reminded about.

Worked examples of candidates that must NOT be selected, because the sender - not the person - is the one who owes the next action:
- "Thank you for your interest in Two Sigma! We've successfully received your application... What happens now?" - a rhetorical FAQ heading in an automated acknowledgment, not a question actually addressed to the person.
- "Our team is currently reviewing your profile and will reach out if there's a match." - they explicitly said THEY will reach out; there is nothing for the person to do.
- "Thank you so much for taking the time to apply... we genuinely appreciate it." - a pure thank-you with no request attached.

An example of a candidate that SHOULD be selected: "Could you confirm which of these three time slots works for you?" - the sender is explicitly waiting on a reply from the person.

When genuinely unsure whether a candidate belongs in the person's court, do not select it - a missed reminder costs nothing; a false one erodes trust in every future nudge.

You will be given a numbered list of candidates. Respond with strict JSON only, no other text, no markdown fences:
{"selected": [{"index": <candidate number>, "title": "<short title, under 10 words>", "body": "<one direct sentence explaining why this needs attention now>"}]}

Select at most 3. If none are genuinely worth surfacing, respond with exactly:
{"selected": []}`;

function formatCandidates(candidates: RuleCandidate[]): string {
  return candidates.map((candidate, index) => `${index + 1}. ${candidate.summary}`).join("\n");
}

/**
 * One model call per detector run reviewing the whole batch (never one
 * call per candidate, per the PRD) - picks 0-3 candidates worth actually
 * surfacing as a nudge.
 */
export async function filterRelevantCandidates(ruleName: string, candidates: RuleCandidate[]): Promise<SelectedNudge[]> {
  if (candidates.length === 0) return [];

  const prompt = `Rule: ${ruleName}\n\nCandidates:\n${formatCandidates(candidates)}`;
  const raw = await ollamaGenerate(SYSTEM_PROMPT, prompt);
  const cleaned = raw.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as Record<string, unknown>).selected)) {
    return [];
  }

  const selected = (parsed as { selected: unknown[] }).selected;
  const results: SelectedNudge[] = [];

  for (const entry of selected.slice(0, 3)) {
    if (!entry || typeof entry !== "object") continue;
    const { index, title, body } = entry as Record<string, unknown>;
    if (typeof index !== "number" || typeof title !== "string" || typeof body !== "string") continue;
    const candidate = candidates[index - 1];
    if (!candidate) continue;
    results.push({ candidate, title: title.trim(), body: body.trim() });
  }

  return results;
}
