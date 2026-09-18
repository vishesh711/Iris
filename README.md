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
4. For voice transcription, install whisper.cpp and ffmpeg (used to transcode Telegram's OGG/Opus voice notes to WAV before transcribing), then download a model:
   ```
   brew install whisper-cpp ffmpeg
   ls "$(brew --prefix)/bin" | grep whisper   # confirm the binary name — whisper-cli on recent versions
   curl -L -o ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
   ```
   Then set in `.env`:
   ```
   WHISPER_BINARY_PATH=whisper-cli
   WHISPER_MODEL_PATH=/absolute/path/to/ggml-base.en.bin
   ```
5. For classification, run [Ollama](https://ollama.com) locally and pull a model (`ollama pull llama3.2`), then set `OLLAMA_HOST` / `OLLAMA_MODEL` in `.env` if you're not using the defaults.
6. Run the bot and the worker in separate terminals:
   ```
   npm run dev:bot
   npm run dev:worker
   ```

Message the bot on Telegram — it replies "got it." immediately. Text lands in `events` and gets classified in the background; a voice note gets transcribed first, and the transcript is then classified.

Optional: to route capture/approval/brief traffic into a Telegram supergroup's topics, create the topics and set `TELEGRAM_CAPTURE_TOPIC_ID` / `TELEGRAM_APPROVALS_TOPIC_ID` / `TELEGRAM_BRIEF_TOPIC_ID` in `.env`.

### Troubleshooting

`role "iris" does not exist` when running `db:migrate`, even after recreating the Docker volume: something else on your machine (Postgres.app, a Homebrew `postgresql` service) is already bound to the port Docker is trying to use and is intercepting the connection first. Check with `lsof -i :<port>`. Iris's own Postgres runs on host port **55432** (see `docker-compose.yml`) specifically to avoid the common 5432/5433 collisions; make sure `DATABASE_URL` in your `.env` matches (`.env.example` already does). If `docker compose up -d` itself fails with "address already in use" even right after a fresh `down -v`, that's usually Docker Desktop's own port-forwarding not having released yet — fully quit and reopen Docker Desktop (not just `docker compose down`) before retrying.

Classification jobs failing with `connect ECONNREFUSED ::1:11434` even though Ollama is clearly running (`ollama list` works): Node resolved `localhost` to the IPv6 loopback address, but Ollama only listens on IPv4 (`127.0.0.1`). `.env.example`'s `OLLAMA_HOST` already uses `127.0.0.1` instead of `localhost` to sidestep this — make sure your own `.env` does too. Separately, if you started Ollama with a bare `ollama serve &` in a terminal, it dies when that terminal closes; run it via the Ollama.app menu bar app or `brew services start ollama` so it survives independently.

A worker job repeatedly fails and gives up (shows `state: 'failed'` in `select * from pgboss.job`, not `retry` or `created`): that's pg-boss's normal behavior once a job exhausts its retries — it's dead-lettered, not silently lost or endlessly retried. Fix the underlying cause (usually Ollama/Whisper not reachable) and send a new message; the old failed job stays as a permanent record and won't reprocess on its own.

## Layout

- `src/bot` — Telegram long-poll process. Writes events, acknowledges instantly, enqueues background work. Does no reasoning itself.
- `src/worker` — background process: transcription, classification, and (later) memory extraction, ingest, and detectors.
- `src/db` — Drizzle schema and Postgres client.
- `src/lib` — shared core library (event ledger, queue, storage, Whisper/Ollama clients).
- `docker/` — local Postgres + pgvector setup.
- `docs/` — design docs.
