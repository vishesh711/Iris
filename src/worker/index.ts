import "dotenv/config";
import "../lib/network.js";
import { getBoss, QUEUES } from "../lib/queue.js";
import { runTranscribeJob, type TranscribeJobData } from "./jobs/transcribe.js";
import { runClassifyJob, type ClassifyJobData } from "./jobs/classify.js";
import { runExtractMemoryJob, type ExtractMemoryJobData } from "./jobs/extract-memory.js";
import { runIngestGmailJob } from "./jobs/ingest-gmail.js";
import { runIngestCalendarJob } from "./jobs/ingest-calendar.js";
import { runExtractEntityJob, type ExtractEntityJobData } from "./jobs/extract-entities.js";
import { runEmbedJob, type EmbedJobData } from "./jobs/embed.js";
import { runAskJob, type AskJobData } from "./jobs/ask.js";
import { runDetectorsJob } from "./jobs/run-detectors.js";
import { runMorningBriefJob } from "./jobs/morning-brief.js";

const INGEST_CRON = "*/5 * * * *";
const DETECTORS_CRON = "0 * * * *"; // hourly
const MORNING_BRIEF_CRON = "0 8 * * *"; // 8am UTC daily — adjust to your timezone if this drifts from actual morning

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

  await boss.work<EmbedJobData>(QUEUES.embed, async (jobs) => {
    for (const job of jobs) {
      await runEmbedJob(job.data);
    }
  });

  await boss.work<AskJobData>(QUEUES.ask, async (jobs) => {
    for (const job of jobs) {
      await runAskJob(job.data);
    }
  });

  await boss.work(QUEUES.runDetectors, async () => {
    await runDetectorsJob();
  });

  await boss.work(QUEUES.morningBrief, async () => {
    await runMorningBriefJob();
  });

  await boss.schedule(QUEUES.ingestGmail, INGEST_CRON);
  await boss.schedule(QUEUES.ingestCalendar, INGEST_CRON);
  await boss.schedule(QUEUES.runDetectors, DETECTORS_CRON);
  await boss.schedule(QUEUES.morningBrief, MORNING_BRIEF_CRON);

  console.log("Iris worker is listening.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
