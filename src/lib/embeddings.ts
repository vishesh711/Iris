import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

const MODEL_NAME = process.env.EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMENSIONS = 384;

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", MODEL_NAME) as Promise<FeatureExtractionPipeline>;
  }
  return extractorPromise;
}

/**
 * Runs entirely locally (transformers.js, ONNX runtime) — no API call, no
 * per-embedding cost. The model itself downloads once on first use and is
 * cached under the OS's default cache dir.
 */
export async function embedText(text: string): Promise<number[]> {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

const MAX_CHUNK_CHARS = 800;

/**
 * Fixed-size chunking with no overlap — a deliberately simple starting
 * point (sentence/paragraph-aware chunking would improve retrieval
 * quality but isn't needed to validate the hybrid-retrieval pipeline
 * itself). Pure and unit tested.
 */
export function chunkText(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const chunks: string[] = [];
  let start = 0;
  while (start < trimmed.length) {
    const chunk = trimmed.slice(start, start + maxChars).trim();
    if (chunk) chunks.push(chunk);
    start += maxChars;
  }
  return chunks;
}
