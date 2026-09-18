export function extractMessageText(rawData: unknown): string {
  if (rawData && typeof rawData === "object") {
    const data = rawData as Record<string, unknown>;
    if (typeof data.text === "string") return data.text;
    if (typeof data.caption === "string") return data.caption;
  }
  return "";
}
