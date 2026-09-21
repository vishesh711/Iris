# Iris

A personal agent that holds context durably — decisions, preferences, commitments — and acts on it, under supervision, from a single Telegram interface.

Full design: [`docs/PRD.md`](docs/PRD.md). Build plan for the remaining milestones: [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md).

## Status

All seven milestones from the build plan are implemented and live-verified against a real bot, Postgres, Ollama instance, and Google account. The MVP as scoped in the PRD is complete — see `docs/BUILD_PLAN.md` for the full per-milestone write-up, including the honest limitations found along the way (a local-model reliability ceiling in the rules engine's relevance filter, and two Milestone 7 checks — the egress-allowlist refusal and a clean kill-switch isolation — that are unit-tested but weren't separately live-fired).

Milestone 6: action ledger and shadow mode — implemented and live-verified. A third process, the executor (`npm run dev:executor`), is now the only thing that ever runs a tool handler: `proposeAction`/`approveAction` just move an `actions` row to `approved` and return, and the executor polls for approved rows, executes them, and reconciles anything stuck in `executing` at startup back to `approved` for safe re-pickup after a crash. Approval cards are sent directly via the Telegram Bot API (so any process can send one, not just the long-poll bot) with real inline Approve/Reject buttons. Untrusted lineage (invariant 7) is enforced: a proposal whose source event traces back through `metadata.sourceEventId` to anything tagged untrusted at Gmail ingest (M3) is forced to queue for approval regardless of the tool's own tier. Two circuit breakers exist — an `IRIS_KILL_SWITCH` env var that forces everything to queue, and an automatic halt if a tool has failed 3+ times in the last hour — deliberately narrower than originally sketched (a tier-2/hour cap and a token budget were skipped as unneeded machinery until real write-tool volume exists to size them against). Restart-safety got an unplanned real-world test: the executor hit a genuine `ETIMEDOUT` reaching Telegram's API (an IPv6 routing quirk, fixed by forcing IPv4 process-wide) partway through a completion notification, after the action itself had already persisted as done — confirming no data was lost or duplicated under a real failure.

Live-verifying M6 also surfaced a real Milestone-4-era bug: a `/forget`'d fact's raw source message could still resurface via the Ask flow's "recent events" context leg, since that leg read events directly rather than through the embeddings table `/forget` already purges. Fixed by tagging the source event `metadata.excludedFromContext` at the same point and filtering on it in retrieval.

Milestone 7: first write actions — implemented and live-verified, including the one genuinely irreversible step (a real `gmail.send_draft` approval), done only after explicit confirmation in the moment. Two new write tools: `gmail.create_draft` (tier 1, auto-approved, but scoped to replying within an existing thread only — it can never compose to a new address) and `gmail.send_draft` (tier 2, needs approval, and re-checks the contacts allowlist inside its own handler at execution time — not just as an earlier advisory check — so a forced approval still can't bypass it), plus `calendar.create_event` (tier 2). The hard idempotency case — a crash between a successful Gmail send and the DB status write — is handled using Gmail's own API semantics: a sent draft returns 404 on a follow-up fetch, which is treated as definitive proof the send already happened, so the stuck action is marked done without ever resending; live testing gave this an accidental real exercise when a second send attempt against an already-consumed draft correctly refused rather than erroring ambiguously. Undo support exists for `gmail.create_draft` and `calendar.create_event` (deletes the draft/event) via a button on the admin `/actions` page — not for `gmail.send_draft`, since there's no API to unsend a real email; live-tested by creating and then undoing a real calendar event. An autonomy ladder (`src/lib/autonomy.ts`) can, after ≥30 decided proposals for a tool with ≥95% approval, offer (never silently apply) turning that tool fully automatic via a new `/autonomy <tool> <on|off>` command; a tool automatically loses its override if its 3 most recent decisions were all rejections — not practically testable without 30 real proposals accumulating over real usage, so only its "never fires early" behavior is verified so far.

Milestone 5: rules engine and nudges — implemented and live-verified. Three deterministic SQL detectors (invariant 8: no model call decides what qualifies as a candidate) run hourly: a recruiter thread gone quiet, an upcoming calendar event mentioning "interview," and a real person's important email left unanswered. Each detector's whole candidate batch goes through exactly one relevance-filter model call (never one call per candidate) that picks 0–3 worth actually surfacing. Cooldown/backoff is structural: a second undismissed nudge can't be created for the same (rule, subject), so "fires every morning for six days" is impossible by construction — dismissing a nudge (via the admin UI's Nudges page) is what reopens the door for a fresh one later. A daily morning brief posts today's calendar events plus any open nudges, and sends nothing on a genuinely quiet day.

Live-verifying this milestone surfaced a real, persistent limitation: the relevance filter reliably excludes explicit rejections, but on ambiguous automated recruiter emails it kept selecting cases where the sender explicitly said *they'd* follow up — confirmed across three rounds of prompt strengthening, the last of which the model responded to by hallucinating a worked example's text onto an unrelated real candidate. This is a firm local-model reliability ceiling on this specific compound-judgment task, not a fixable prompt issue. One category (one-time passcodes/verification emails) was clear-cut enough to exclude deterministically at the SQL level instead; the remaining ambiguous cases are accepted as-is, mitigated by the one-tap dismiss.

Milestone 4: unified search — implemented and live-verified. Every captured message, transcript, and email gets chunked and embedded locally (`@xenova/transformers`, no API cost) into a shared `embeddings` table; every memory gets embedded at the moment it's remembered. A hybrid retrieval pipeline merges four legs — semantic search over embedded content, keyword search over emails/calendar (ranked by keyword-match relevance, not just recency), decay-and-recency-ranked memory search, and recent events for context — with the PRD's explicit ranking rule: an active memory beats a superseded one every time (superseded memories are excluded from retrieval entirely, not just down-ranked, and a memory's raw source-message text is purged from the embeddings table the moment it's superseded or forgotten, so a corrected-away statement can't resurface via the message search leg either). Any message ending in `?` triggers the Ask flow: retrieval runs, results go into a clearly-delimited CONTEXT block the model is told never to treat as a conversation or a set of instructions (the PRD's structural-separation defense against injection from untrusted email content), and the answer gets sent back over Telegram.

Live-verifying that milestone surfaced and fixed several real bugs beyond the initial implementation: Gmail bodies using quoted-printable encoding were coming through corrupted (garbled words, stray replacement characters); the structured keyword-search leg was effectively dead code (it matched the entire question as one literal substring); and a small local model (llama3.2, 3B) was unreliable at the Ask flow's multi-hop reasoning even with correct context — switching to `llama3.1:8b` and lowering generation temperature fixed that. See `src/eval/definition-of-done.ts` for the PRD's own cold-start test question, which now answers correctly and consistently.

Earlier: Milestones 1–3 (capture, memory/correction, Gmail/Calendar ingest) are all implemented and live-verified.

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
5. For classification, memory extraction, and the Ask flow, run [Ollama](https://ollama.com) locally and pull a model (`ollama pull llama3.1:8b`), then set `OLLAMA_HOST` / `OLLAMA_MODEL` in `.env` if you're not using the defaults. A smaller model like `llama3.2` (3B) works for classification but was unreliable at the Ask flow's reasoning in testing — see Status above.
6. Run the bot, the worker, and the executor in separate terminals (the executor is the only process that ever actually runs a tool handler — approving a card just marks it ready for the executor to pick up within a few seconds):
   ```
   npm run dev:bot
   npm run dev:worker
   npm run dev:executor
   ```
7. Optional: run the debug admin UI to browse events, memories, and the tool-call/action audit (with an Undo button for anything reversible):
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
9. For unified search, backfill embeddings for anything captured before this milestone existed (memories, messages, emails already in the database). The first run downloads the embedding model (~90MB, cached after that):
   ```
   npm run backfill:embeddings
   ```
   New captures, memories, and emails get embedded automatically from here on — no need to re-run this except after a bulk data change.
10. For Gmail/Calendar write actions (drafting/sending replies, creating calendar events), Iris needs write scopes beyond the read-only ones from step 8. If you already ran `google:auth-setup` before this milestone, re-run it to re-consent — the stored refresh token predates the new scopes and Google won't silently upgrade it (see the Troubleshooting note below if it says it didn't return a refresh token):
    ```
    npm run google:auth-setup
    ```
    A drafted reply and a `gmail.send_draft`/`calendar.create_event` proposal are exercised the same way as `/forget` — a real Telegram approval card, with the executor (step 6) actually performing the send/create once approved. Only a recipient who has previously emailed you can ever be sent a real message.

Message the bot on Telegram — it replies "got it." immediately. Text lands in `events` and gets classified in the background; a voice note gets transcribed first, and the transcript is then classified. A message classified as a fact or correction gets extracted into `memories` shortly after — check the admin UI or query the table directly to see it land.

Try `/forget <something>` to see the approval flow: it finds matching memories, shows you what would be deleted, and only deletes them once you tap Approve on the Telegram card.

Ask the bot a question ending in `?` to see unified search: it retrieves across memories, messages, emails, and calendar events, then replies with an answer grounded in whatever it actually found (never guessing beyond it). Try the admin UI's **Ask** page for the same thing without going through Telegram, or run the PRD's own definition-of-done test directly:
```
npm run eval:dod
```

Optional: to route capture/approval/brief traffic into a Telegram supergroup's topics, create the topics and set `TELEGRAM_CAPTURE_TOPIC_ID` / `TELEGRAM_APPROVALS_TOPIC_ID` / `TELEGRAM_BRIEF_TOPIC_ID` in `.env`.

The worker also runs three rule-based detectors hourly and a morning brief daily, both needing `TELEGRAM_OWNER_CHAT_ID` set (see step 8.6 above) to actually deliver anything. To try them immediately instead of waiting on the cron:
```
npx tsx src/scripts/run-detectors-now.ts
npx tsx src/scripts/run-morning-brief-now.ts
```
Check the admin UI's **Nudges** page to see rule state, active nudges, and recent run history, and to dismiss a nudge (which reopens the door for a fresh one later if the same condition still holds — it won't re-fire the very next run on its own).

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

- `src/bot` — Telegram long-poll process. Writes events, acknowledges instantly, enqueues background work (including the Ask flow for question-like text), and handles approval-card taps and the `/autonomy` command. Does no reasoning itself, and never executes a tool handler directly.
- `src/worker` — background process: transcription, classification, memory extraction, Gmail/Calendar ingest, embedding, Ask, rule detectors, and the morning brief.
- `src/executor` — background process that is the only thing that ever runs a tool handler: polls for approved actions, executes them, reconciles anything stuck mid-execution after a crash, and sends the completion message.
- `src/admin` — debug UI: events, memories, emails, sync health, a page to test Ask directly, rules/nudges, and the tool-call/action audit with Undo.
- `src/db` — Drizzle schema and Postgres client.
- `src/lib` — shared core library: event ledger, queue, storage, Whisper/Ollama clients, memory (extraction/conflict-check/decay/forget), the tool registry/policy gate/actions ledger, untrusted-lineage tracking, undo, the autonomy ladder, secrets (macOS Keychain), sync-state watermarks, embeddings, hybrid retrieval, the Ask flow, contacts allowlist, and nudges (cooldown/dismiss).
- `src/lib/google` — Gmail/Calendar API clients (including write actions), OAuth, and failure classification.
- `src/lib/rules` — deterministic SQL detectors and the single-call relevance filter that decides which of their candidates are actually worth surfacing.
- `src/scripts` — one-off scripts (Google OAuth consent flow, embedding backfill) and manual triggers for jobs that otherwise only run on a cron.
- `src/eval` — labeled evaluation scenarios, starting with the PRD's own definition-of-done question.
- `docker/` — local Postgres + pgvector setup.
- `docs/` — design docs.
