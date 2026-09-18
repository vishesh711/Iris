export type TopicName = "capture" | "approvals" | "brief";

const ENV_VAR_BY_TOPIC: Record<TopicName, string> = {
  capture: "TELEGRAM_CAPTURE_TOPIC_ID",
  approvals: "TELEGRAM_APPROVALS_TOPIC_ID",
  brief: "TELEGRAM_BRIEF_TOPIC_ID",
};

/**
 * Resolves a configured supergroup topic (message thread) id. Returns
 * undefined when the topic isn't configured, so callers fall back to a
 * plain chat without topics.
 */
export function topicThreadId(topic: TopicName): number | undefined {
  const raw = process.env[ENV_VAR_BY_TOPIC[topic]];
  return raw ? Number(raw) : undefined;
}
