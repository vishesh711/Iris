import { ollamaGenerate } from "../ollama.js";
import type { RuleCandidate } from "./types.js";

export interface SelectedNudge {
  candidate: RuleCandidate;
  title: string;
  body: string;
}

const SYSTEM_PROMPT = `You review candidate nudges for a personal agent and decide which, if any, are actually worth interrupting the person about right now. Most days most candidates are NOT worth surfacing - be selective.

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
