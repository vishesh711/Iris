import "dotenv/config";
import { answerQuestion } from "../lib/ask.js";

/**
 * The PRD's own bar for the whole MVP: if this resolves correctly from a
 * cold process with no context supplied in the prompt, the retrieval
 * foundation is sound. This is eval case #1 — the labeled set the PRD
 * asks for (50-100 scenarios) grows from real usage from here; there's
 * no way to fabricate the other 49 honestly without real data to check
 * them against.
 */
const QUESTION = "Who was the recruiter that contacted me about the contract role, and what did I decide about the rate?";

async function main() {
  console.log(`Q: ${QUESTION}\n`);
  const answer = await answerQuestion(QUESTION);
  console.log(`A: ${answer}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
