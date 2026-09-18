import { extractMemoryCandidate } from "../src/lib/memory-extraction.js";

const messages = [
  "My favorite coffee order is a flat white.",
  "I live in Philadelphia now.",
  "My manager's name is Priya.",
];

for (const message of messages) {
  const candidate = await extractMemoryCandidate(message);
  console.log(JSON.stringify(candidate), "\t<-", message);
}
