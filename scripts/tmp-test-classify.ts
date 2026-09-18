import { classifyCapture } from "../src/lib/classifier.js";

const messages = [
  "My favorite coffee order is a flat white.",
  "I live in Philadelphia now.",
  "My manager's name is Priya.",
  "I need to call the dentist.",
  "Remind me about the meeting at 3pm on Friday.",
  "Actually, I moved to Boston, not Philadelphia.",
  "lol that's funny",
  "What's the weather like today?",
];

for (const message of messages) {
  const label = await classifyCapture(message);
  console.log(`${label}\t${message}`);
}
