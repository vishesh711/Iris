import { embedAndStoreChunks, type EmbeddableSourceTable } from "../../lib/embed-store.js";

export interface EmbedJobData {
  sourceTable: EmbeddableSourceTable;
  sourceId: string;
  text: string;
}

export async function runEmbedJob(data: EmbedJobData): Promise<void> {
  if (!data.text.trim()) return;
  await embedAndStoreChunks(data.sourceTable, data.sourceId, data.text);
}
