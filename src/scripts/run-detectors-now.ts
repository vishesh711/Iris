import "dotenv/config";
import { runDetectorsJob } from "../worker/jobs/run-detectors.js";

/**
 * Manual trigger for live-verifying the rules engine without waiting for
 * its hourly cron. Runs the exact same job the worker's schedule fires.
 */
runDetectorsJob()
  .then(() => {
    console.log("Detectors run complete.");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
