const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2";

export async function ollamaGenerate(system: string, prompt: string): Promise<string> {
  const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      system,
      prompt,
      stream: false,
      // Every caller here (classification, extraction, conflict-check,
      // Ask) wants the same grounded, consistent answer given the same
      // input, not creative variation - Ollama's default temperature is
      // high enough to visibly change answers across identical runs.
      options: { temperature: 0.1 },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status}`);
  }

  const body = (await response.json()) as { response?: string };
  return (body.response ?? "").trim();
}
