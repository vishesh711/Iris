import "dotenv/config";
import { writeFileSync } from "node:fs";
import { retrieve } from "../lib/retrieval.js";

/**
 * Ad-hoc debug tool: prints the raw retrieval legs for a query, so you can
 * see exactly what context the Ask flow's model call actually receives.
 * Not wired into any npm script — run directly with tsx when diagnosing a
 * retrieval-quality issue. Writes the full, untruncated, unmodified items
 * to a JSON file (in addition to a console preview) to rule out any
 * console.log/terminal-rendering artifact in the preview itself.
 */
const query = process.argv[2] ?? "Who was the recruiter that contacted me about the contract role, and what did I decide about the rate?";

async function main() {
  const items = await retrieve(query);

  writeFileSync("/tmp/debug-retrieve-output.json", JSON.stringify(items, null, 2), "utf8");
  console.log("Wrote full raw items to /tmp/debug-retrieve-output.json\n");

  console.log(`Query: ${query}\n`);
  console.log(`${items.length} items retrieved:\n`);
  for (const item of items) {
    console.log(`[${item.kind}] score=${item.score.toFixed(3)}`);
    console.log(item.text.slice(0, 300).replace(/\n/g, " ⏎ "));
    console.log(JSON.stringify(item.metadata));
    console.log("---");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
