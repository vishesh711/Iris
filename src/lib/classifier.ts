const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2";

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
  const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      system: SYSTEM_PROMPT,
      prompt: text,
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama classify request failed: ${response.status}`);
  }

  const body = (await response.json()) as { response?: string };
  const label = body.response?.trim().toLowerCase();
  return (CAPTURE_LABELS as readonly string[]).includes(label ?? "")
    ? (label as CaptureLabel)
    : "conversation";
}
