# Iris

A personal agent that holds context durably — decisions, preferences, commitments — and acts on it, under supervision, from a single Telegram interface.

Full design: [`docs/PRD.md`](docs/PRD.md). Build plan for the remaining milestones: [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md).

## Status

Milestone 1: capture is real. The bot process writes every message to the `events` ledger and acknowledges instantly; a separate worker process transcribes voice notes locally via Whisper and classifies captured text (fact / task / reminder / correction / conversation) via a local Ollama model, in the background, without slowing the "got it." reply.

## Setup

1. Start Postgres:
   ```
   docker compose up -d
   ```
2. Copy the env file and fill in your bot token (create one via [@BotFather](https://t.me/BotFather)):
   ```
   cp .env.example .env
   ```
3. Install dependencies and apply the schema:
   ```
   npm install
   npm run db:generate
   npm run db:migrate
   ```
4. For voice transcription, install a whisper.cpp-compatible CLI and a model, then set `WHISPER_BINARY_PATH` / `WHISPER_MODEL_PATH` in `.env`.
5. For classification, run [Ollama](https://ollama.com) locally and pull a model (`ollama pull llama3.2`), then set `OLLAMA_HOST` / `OLLAMA_MODEL` in `.env` if you're not using the defaults.
6. Run the bot and the worker in separate terminals:
   ```
   npm run dev:bot
   npm run dev:worker
   ```

Message the bot on Telegram — it replies "got it." immediately. Text lands in `events` and gets classified in the background; a voice note gets transcribed first, and the transcript is then classified.

Optional: to route capture/approval/brief traffic into a Telegram supergroup's topics, create the topics and set `TELEGRAM_CAPTURE_TOPIC_ID` / `TELEGRAM_APPROVALS_TOPIC_ID` / `TELEGRAM_BRIEF_TOPIC_ID` in `.env`.

## Layout

- `src/bot` — Telegram long-poll process. Writes events, acknowledges instantly, enqueues background work. Does no reasoning itself.
- `src/worker` — background process: transcription, classification, and (later) memory extraction, ingest, and detectors.
- `src/db` — Drizzle schema and Postgres client.
- `src/lib` — shared core library (event ledger, queue, storage, Whisper/Ollama clients).
- `docker/` — local Postgres + pgvector setup.
- `docs/` — design docs.
