import "dotenv/config";
import { getBoss, QUEUES } from "../lib/queue.js";
import { runTranscribeJob, type TranscribeJobData } from "./jobs/transcribe.js";
import { runClassifyJob, type ClassifyJobData } from "./jobs/classify.js";

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

  console.log("Iris worker is listening.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
