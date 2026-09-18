import { extractMemoryCandidate } from "../src/lib/memory-extraction.js";

const messages = [
  "Actually my favorite coffee order is a cortado now.",
  "Actually, I moved to Boston, not Philadelphia.",
];

for (const message of messages) {
  const candidate = await extractMemoryCandidate(message);
  console.log(JSON.stringify(candidate), "\t<-", message);
}
