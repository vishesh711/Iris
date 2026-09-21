import "dotenv/config";
import "../lib/network.js";
import { runIngestGmailJob } from "../worker/jobs/ingest-gmail.js";

/**
 * Manual trigger for live-verifying Gmail ingest without waiting for its
 * 5-minute cron — e.g. right after re-consenting to new OAuth scopes, or
 * when a specific just-sent test email needs to show up in the admin UI
 * immediately. Runs the exact same job the worker's schedule fires.
 */
runIngestGmailJob()
  .then(() => {
    console.log("Gmail ingest run complete.");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
