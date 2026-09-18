import "dotenv/config";
import { getBoss, QUEUES } from "../lib/queue.js";
import { runTranscribeJob, type TranscribeJobData } from "./jobs/transcribe.js";
import { runClassifyJob, type ClassifyJobData } from "./jobs/classify.js";
import { runExtractMemoryJob, type ExtractMemoryJobData } from "./jobs/extract-memory.js";
import { runIngestGmailJob } from "./jobs/ingest-gmail.js";
import { runIngestCalendarJob } from "./jobs/ingest-calendar.js";
import { runExtractEntityJob, type ExtractEntityJobData } from "./jobs/extract-entities.js";

const INGEST_CRON = "*/5 * * * *";

async function main() {
  const boss = await getBoss();

  await boss.work<TranscribeJobData>(QUEUES.transcribe, async (jobs) => {
    for (const job of jobs) {
      await runTranscribeJob(job.data);
    }
  });

  await boss.work<ClassifyJobData>(QUEUES.classify, async (jobs) => {
    for (const job of jobs) {
      await runClassifyJob(job.data);
    }
  });

  await boss.work<ExtractMemoryJobData>(QUEUES.extractMemory, async (jobs) => {
    for (const job of jobs) {
      await runExtractMemoryJob(job.data);
    }
  });

  await boss.work(QUEUES.ingestGmail, async () => {
    await runIngestGmailJob();
  });

  await boss.work(QUEUES.ingestCalendar, async () => {
    await runIngestCalendarJob();
  });

  await boss.work<ExtractEntityJobData>(QUEUES.extractEntities, async (jobs) => {
    for (const job of jobs) {
      await runExtractEntityJob(job.data);
    }
  });

  await boss.schedule(QUEUES.ingestGmail, INGEST_CRON);
  await boss.schedule(QUEUES.ingestCalendar, INGEST_CRON);

  console.log("Iris worker is listening.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
