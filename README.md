# Iris

A personal agent that holds context durably — decisions, preferences, commitments — and acts on it, under supervision, from a single Telegram interface.

Full design: [`docs/PRD.md`](docs/PRD.md). Build plan for the remaining milestones: [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md).

## Status

Milestone 3 (live-verified): read-only Gmail and Calendar ingest, on top of Milestones 1–2's capture and memory pipeline. A background job polls Gmail's history API and Google Calendar's incremental sync every 5 minutes, upserting into `emails`/`calendar_events` on their provider ids so re-delivery never duplicates. Every Gmail/Calendar-sourced event is tagged `untrusted` in the ledger at ingest time. Senders get classified (currently a cheap keyword heuristic, e.g. `recruiter`) into an `entities` table. An expired Google token surfaces as an immediate Telegram alert instead of silently going quiet. The PRD calls for this to go through MCP clients; this build uses Google's official API client directly instead — see `docs/BUILD_PLAN.md` for why.

Earlier: Milestone 2 (memory, correction, `/forget`, the tool registry/policy gate) and Milestone 1 (Telegram capture, voice transcription, classification) are both implemented and live-verified.

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
7. Optional: run the debug admin UI to browse events and memories:
   ```
   npm run dev:admin
   ```
   Then open http://localhost:4000.
8. For Gmail/Calendar ingest, set up a Google OAuth credential:
   1. Go to the [Google Cloud Console](https://console.cloud.google.com/), create a project (or use an existing one).
   2. **APIs & Services → Library** — enable the **Gmail API** and **Google Calendar API**.
   3. **APIs & Services → OAuth consent screen** — choose **External**, fill in the required fields, and add your own Google account under **Test users** (this keeps the app in testing mode, which is fine for personal use — no Google review needed).
   4. **APIs & Services → Credentials → Create Credentials → OAuth client ID** — application type **Desktop app**. Copy the generated Client ID and Client Secret.
   5. Put those in `.env`:
      ```
      GOOGLE_CLIENT_ID=...
      GOOGLE_CLIENT_SECRET=...
      ```
   6. Find your Telegram chat id (message the bot once first, then):
      ```
      docker exec -it iris-postgres-1 psql -U iris -d iris -c "select raw_data->'chat'->>'id' from events where source='telegram' order by received_at desc limit 1;"
      ```
      Put it in `.env` as `TELEGRAM_OWNER_CHAT_ID`.
   7. Run the one-time consent flow — it prints a URL, opens your Mac's Keychain access under the hood, and saves the refresh token there (never in `.env`):
      ```
      npm run google:auth-setup
      ```
   8. Restart `npm run dev:worker` — it polls Gmail and Calendar every 5 minutes from here on. Check progress via the admin UI's **Health** and **Emails** pages, or:
      ```
      docker exec -it iris-postgres-1 psql -U iris -d iris -c "select key, last_synced_at, last_error from sync_state;"
      ```

Message the bot on Telegram — it replies "got it." immediately. Text lands in `events` and gets classified in the background; a voice note gets transcribed first, and the transcript is then classified. A message classified as a fact or correction gets extracted into `memories` shortly after — check the admin UI or query the table directly to see it land.

Try `/forget <something>` to see the approval flow: it finds matching memories, shows you what would be deleted, and only deletes them once you tap Approve on the Telegram card.

Optional: to route capture/approval/brief traffic into a Telegram supergroup's topics, create the topics and set `TELEGRAM_CAPTURE_TOPIC_ID` / `TELEGRAM_APPROVALS_TOPIC_ID` / `TELEGRAM_BRIEF_TOPIC_ID` in `.env`.

## Tests

```
npm test
```

Runs the unit suite — decay curves, idempotency key derivation, memory extraction/conflict-check parsing, and the permission gate (the PRD calls this last one "the highest-value test file in the repository": every tier-2 tool must be denied automatic execution, and an unregistered tool must fail closed rather than default to permissive). These are all pure-logic tests with the LLM calls mocked; they don't need Postgres, Ollama, or Whisper running.

### Troubleshooting

`role "iris" does not exist` when running `db:migrate`, even after recreating the Docker volume: something else on your machine (Postgres.app, a Homebrew `postgresql` service) is already bound to the port Docker is trying to use and is intercepting the connection first. Check with `lsof -i :<port>`. Iris's own Postgres runs on host port **55432** (see `docker-compose.yml`) specifically to avoid the common 5432/5433 collisions; make sure `DATABASE_URL` in your `.env` matches (`.env.example` already does). If `docker compose up -d` itself fails with "address already in use" even right after a fresh `down -v`, that's usually Docker Desktop's own port-forwarding not having released yet — fully quit and reopen Docker Desktop (not just `docker compose down`) before retrying.

Classification jobs failing with `connect ECONNREFUSED ::1:11434` even though Ollama is clearly running (`ollama list` works): Node resolved `localhost` to the IPv6 loopback address, but Ollama only listens on IPv4 (`127.0.0.1`). `.env.example`'s `OLLAMA_HOST` already uses `127.0.0.1` instead of `localhost` to sidestep this — make sure your own `.env` does too. Separately, if you started Ollama with a bare `ollama serve &` in a terminal, it dies when that terminal closes; run it via the Ollama.app menu bar app or `brew services start ollama` so it survives independently.

A worker job repeatedly fails and gives up (shows `state: 'failed'` in `select * from pgboss.job`, not `retry` or `created`): that's pg-boss's normal behavior once a job exhausts its retries — it's dead-lettered, not silently lost or endlessly retried. Fix the underlying cause (usually Ollama/Whisper not reachable) and send a new message; the old failed job stays as a permanent record and won't reprocess on its own.

`npm run google:auth-setup` says "Google did not return a refresh token": Google only issues a refresh token on the first consent, unless you force it. If you've authorized this app before (even during earlier testing), revoke it at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and run the setup script again.

Gmail/Calendar ingest silently does nothing: check `select * from sync_state;` — if there's no row at all, `getAuthorizedClient()` is throwing (no refresh token stored yet, run the setup script) and the worker is logging that to its own console, not the database.

## Layout

- `src/bot` — Telegram long-poll process. Writes events, acknowledges instantly, enqueues background work. Does no reasoning itself.
- `src/worker` — background process: transcription, classification, memory extraction, Gmail/Calendar ingest, and (later) detectors.
- `src/admin` — debug UI: events, memories, emails, and sync health.
- `src/db` — Drizzle schema and Postgres client.
- `src/lib` — shared core library: event ledger, queue, storage, Whisper/Ollama clients, memory (extraction/conflict-check/decay/forget), the tool registry/policy gate/actions ledger, secrets (macOS Keychain), and sync-state watermarks.
- `src/lib/google` — Gmail/Calendar API clients, OAuth, and failure classification.
- `src/scripts` — one-off interactive scripts (Google OAuth consent flow).
- `docker/` — local Postgres + pgvector setup.
- `docs/` — design docs.
