import { ollamaGenerate } from "./ollama.js";

export const CAPTURE_LABELS = ["fact", "task", "reminder", "correction", "conversation"] as const;
export type CaptureLabel = (typeof CAPTURE_LABELS)[number];

// Small local models need concrete examples to hold this boundary
// reliably, not just abstract label descriptions — without them, models
// like llama3.2 default to "conversation" for plain declarative
// statements that are actually durable facts worth remembering.
const SYSTEM_PROMPT = `You classify a single captured message into exactly one label.

Labels:
- fact: a durable statement about the user's life, preferences, identity, relationships, or a stable detail about the world worth remembering long-term.
- task: something the user needs to do.
- reminder: a time-bound thing to be reminded about, tied to a specific date or time.
- correction: the user is correcting or updating something they previously stated.
- conversation: small talk, a question, or anything not worth storing long-term.

Examples:
"My favorite coffee order is a flat white." -> fact
"I live in Philadelphia now." -> fact
"My manager's name is Priya." -> fact
"I need to call the dentist." -> task
"Remind me about the meeting at 3pm on Friday." -> reminder
"Actually, I moved to Boston, not Philadelphia." -> correction
"lol that's funny" -> conversation
"What's the weather like today?" -> conversation

Respond with only the label, nothing else — no punctuation, no explanation.`;

export async function classifyCapture(text: string): Promise<CaptureLabel> {
  const raw = await ollamaGenerate(SYSTEM_PROMPT, text);
  const label = raw.trim().toLowerCase();
  return (CAPTURE_LABELS as readonly string[]).includes(label) ? (label as CaptureLabel) : "conversation";
}
