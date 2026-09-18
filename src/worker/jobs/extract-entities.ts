import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { emails } from "../../db/schema.js";
import { upsertEntityForSender } from "../../lib/entities.js";

export interface ExtractEntityJobData {
  emailId: string;
}

export async function runExtractEntityJob(data: ExtractEntityJobData): Promise<void> {
  const [email] = await db.select().from(emails).where(eq(emails.id, data.emailId));
  if (!email) return;

  const entityId = await upsertEntityForSender({
    fromAddress: email.fromAddress,
    fromName: email.fromName,
    subject: email.subject,
    snippet: email.snippet,
  });

  if (entityId) {
    await db.update(emails).set({ entityId }).where(eq(emails.id, email.id));
  }
}
