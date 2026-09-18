import { ollamaGenerate } from "./ollama.js";

export const CAPTURE_LABELS = ["fact", "task", "reminder", "correction", "conversation"] as const;
export type CaptureLabel = (typeof CAPTURE_LABELS)[number];

const SYSTEM_PROMPT = `You classify a single captured message into exactly one label.
Labels:
- fact: a durable statement about the user's life, preferences, or the world worth remembering.
- task: something the user needs to do.
- reminder: a time-bound thing to be reminded about.
- correction: the user is correcting or updating something previously stated.
- conversation: small talk, a question, or anything not worth storing.
Respond with only the label, nothing else.`;

export async function classifyCapture(text: string): Promise<CaptureLabel> {
  const raw = await ollamaGenerate(SYSTEM_PROMPT, text);
  const label = raw.trim().toLowerCase();
  return (CAPTURE_LABELS as readonly string[]).includes(label) ? (label as CaptureLabel) : "conversation";
}
