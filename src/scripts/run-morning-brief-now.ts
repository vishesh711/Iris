import "dotenv/config";
import { runMorningBriefJob } from "../worker/jobs/morning-brief.js";

/**
 * Manual trigger for live-verifying the morning brief without waiting
 * for its daily cron. Runs the exact same job the worker's schedule
 * fires — prints nothing extra, so a silent run means it genuinely had
 * nothing to say (invariant 9), not that the script failed.
 */
runMorningBriefJob()
  .then(() => {
    console.log("Morning brief run complete (check Telegram — silence means nothing to report).");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
