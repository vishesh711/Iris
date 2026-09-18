# Iris — Milestone 1→7 Build Plan

## Context

Milestone 0 (Telegram → `events` ledger, "got it.") is built and merged into PR #1 on `claude/lucid-cray-uv1dyw`. The PRD (`docs/PRD.md`) specifies seven more milestones plus cross-cutting reliability, testing, and permission requirements that are easy to build in the wrong order or drop silently (untrusted lineage, fail-closed policy gate, idempotency, decay-at-query-time, no `user_id` anywhere). This plan sequences Milestones 1–7 so that every step leaves a working system (per the PRD's own rule) and nothing in the spec gets missed. It was drafted by reading the full PRD and auditing the current repo, then validated by a planning pass; two structural calls were made where the PRD's own text creates a milestone-ordering tension:

1. **The tool registry, tiers, and policy gate move from their "natural" Milestone 6 slot to Milestone 2.** The tiers table lists `memory.forget` as tier 2, and `/forget` ships in Milestone 2 per the PRD. So a minimal registry + deterministic gate + the `actions` table (exact DDL) land in M2, gating that one tool. M6 doesn't invent this machinery — it generalizes the M2 version into the real async executor, real approval cards, and circuit breakers.
2. **Untrusted lineage is tagged at Gmail ingest (M3)**, not invented at enforcement time (M6). If Gmail-sourced events aren't marked untrusted the moment they're ingested, that lineage can't be reconstructed later.

Each milestone below reuses the existing conventions from Milestone 0/1: `recordEvent()` / `addEventMetadata()` / `markEventProcessed()` in `src/lib/events.ts` for all ledger writes, the Drizzle schema/migration flow (`src/db/schema.ts` → `npm run db:generate` → `npm run db:migrate`), and the `src/bot` / `src/db` / `src/lib` layout — new top-level dirs (`src/worker`, `src/executor`, `src/mcp`, `src/admin`, `src/eval`) are introduced only where the PRD's process model or testing requirements demand them.

New dependencies get added incrementally per milestone (pg-boss, Ollama client, a local Whisper binary wrapper, `@xenova/transformers` for embeddings, `keytar` for OS keychain, `vitest` for tests) — never all at once.

**Status:** Milestones 1–5 are implemented and live-verified (see below). Milestones 6 and 7 are implemented, pending live verification — M7 in particular involves a real Gmail write-scope re-consent and an irreversible real email send, which needs the person's explicit go-ahead before that specific step, not just a code review.

---

## Milestone 1 — Capture proper ✅ implemented

**Scope (PRD: Capture flow + Processes):** voice notes via local Whisper, forwarded messages/files, a Telegram supergroup with topics (capture/approvals/brief), and background classification decoupled from the instant "got it." This is the milestone that forces the Bot/Worker process split into existence.

**Files:**
- `src/bot/topics.ts` — resolves capture/approvals/brief topic IDs from env (optional; falls back to a plain chat).
- `src/lib/storage.ts` — downloads Telegram files/voice/photos to local disk.
- `src/lib/whisper.ts` — shells out to a local whisper.cpp-compatible CLI for transcription.
- `src/lib/classifier.ts` — calls a local Ollama model to label text as fact/task/reminder/correction/conversation.
- `src/lib/queue.ts` — pg-boss client shared by bot (enqueue) and worker (consume); creates the `transcribe`/`classify` queues on start.
- `src/worker/index.ts` — second process entry point (`npm run dev:worker`).
- `src/worker/jobs/transcribe.ts` — Whisper job; appends a new `events` row (`type: "transcript"`) referencing the source event, then enqueues classification for the transcript — never mutates the original voice event.
- `src/worker/jobs/classify.ts` — labels an event into `events.metadata.label` via `markEventProcessed()`.
- `src/bot/index.ts` — branches on message shape (voice/audio/document/photo/text), keeps `recordEvent()` + instant "got it." synchronous, downloads/enqueues background work after replying.
- `src/lib/events.ts` — added `getEvent()`, `addEventMetadata()` (metadata patch without marking processed), `markEventProcessed()` (patch + `processed_at`).

**Data model:** none — `events.raw_data`/`metadata` (already JSONB) cover files, voice, and labels.

**Cross-cutting landed here:** first Bot/Worker process boundary; pg-boss gives restart-safety via Postgres-backed jobs; a `trace_id` (UUID) is generated per inbound message and threaded through `events.metadata` and job payloads so nothing needs retrofitting later.

**Verification:** text → sub-second "got it." (this is the Capture Friction metric — measure it); voice note → instant ack, then a transcript event once the job runs; forwarded message and a file both land in `events` with correct provenance and the file exists on disk; kill/restart the worker mid-transcription — pg-boss should not duplicate or lose the job.

**Setup needed to exercise it:** a whisper.cpp-compatible binary + model (`WHISPER_BINARY_PATH` / `WHISPER_MODEL_PATH`), and a local Ollama instance with a pulled model (`OLLAMA_HOST` / `OLLAMA_MODEL`). See the root `README.md`.

---

## Milestone 2 — Memory and correction ✅ implemented and live-verified

**Scope (PRD: memories DDL, Correct flow, tiers table):** the conflict-check, decay-at-query-time, supersession, `/forget` — and, pulled forward, the tool registry/policy gate/`actions` table, since `/forget` is tier 2.

**Files:**
- `src/lib/tools/registry.ts` — `{tool, tier, handler}` map; `memory.search` (0), `memory.remember` (1), `memory.forget` (2, with a real handler wired to `executeForget`).
- `src/lib/tools/policy-gate.ts` — `evaluateAction({tool, untrusted})`, pure and deterministic: tier 0/1 → `approved`, tier 2 or untrusted → `queued`, anything it can't evaluate (unregistered tool, malformed tier) → `denied`. No model call, ever; wrapped in try/catch so any internal error fails closed instead of throwing.
- `src/lib/idempotency.ts` — `deriveIdempotencyKey(tool, args)`, a deterministic sha256 over `{tool, args}` with recursively sorted keys so key insertion order can't change the hash. Unit tested.
- `src/lib/actions.ts` — `proposeAction()` writes the `actions` row, runs the gate, and — no async executor until M6 — synchronously executes tier 0/1 approvals inline; `approveAction()`/`rejectAction()` handle the tier-2 tap. Idempotent: a second proposal with an identical tool+args returns the existing row.
- `src/lib/decay.ts` — pure `decayWeight()` for all 5 classes; `identity` never decays, `scheduled` is a hard cutoff at `valid_until`, the other three decay exponentially with a half-life that stretches with `reinforcement_count`. Unit tested (monotonicity, ordering across classes, reinforcement slowing decay, bounds).
- `src/lib/ollama.ts` — extracted shared `ollamaGenerate()` call, reused by `classifier.ts` (Milestone 1) and the two new memory modules below.
- `src/lib/memory-extraction.ts` — `extractMemoryCandidate()`: one model call producing a candidate statement/subject/predicate/object/decayClass, or `null` if nothing's worth storing. Defensively parsed (handles markdown-fenced JSON, malformed JSON, missing fields, an invalid decayClass) — never throws, always degrades to a safe default. Unit tested against a mocked model.
- `src/lib/memory.ts` — `rememberFact()`, `checkConflict()` (the one-model-call-per-write contradicts/extends/independent classification against the nearest existing memories for the same subject; skips the model call entirely when there's nothing to compare against; falls back to `independent` on any parse failure rather than risking a wrongful supersession), `supersedeMemory()`, `bumpReinforcement()`, `previewForget()`/`executeForget()`, `searchMemories()` (applies `decay.ts` at query time only, never persisted). Unit tested.
- `src/worker/jobs/extract-memory.ts` — consumes a `fact`/`correction` classification from Milestone 1's `classify.ts` (which now enqueues this job for those two labels): extracts a candidate, checks for an exact restatement (bumps reinforcement instead of duplicating), runs the conflict-check, and on `contradicts` supersedes the old memory and appends a `type: "correction"` event; on `extends`/`independent` inserts a new memory row.
- `src/bot/commands/forget.ts` — `/forget <target>` previews matches, builds a rationale, and calls `proposeAction("memory.forget", ...)` — goes through the exact same approval card as any other tier-2 action, registered ahead of the generic message handler so it isn't double-processed as ordinary capture.
- `src/admin/server.ts` — debug UI (Express), first 2 of its eventual 6 views: `/events` and `/memories` (with live decay weight computed per row).
- `vitest` added, with a setup file providing a placeholder `DATABASE_URL` so pure-logic unit tests never need a real Postgres connection. `src/lib/tools/policy-gate.test.ts` is the permission suite: tier-2 not auto-approved, tier-0/1 auto-approved, an unregistered tool denied (the "gate errors" case, since this architecture's gate is local deterministic code with no separate service to be network-unreachable), and untrusted lineage forcing the queue regardless of tier (the flag is supported now; M6 adds the lineage-walking that sets it automatically).

**Data model:** `memories` and `actions`, matching the PRD's DDL exactly (verified against the generated migration SQL), plus one added index each (`memories(subject, status)`, and the PRD's own partial index on `actions(status, tier) where status in ('proposed','approved')`, confirmed present in the generated SQL with the correct `WHERE` clause).

**Cross-cutting landed here:** tool registry/tiers/gate exist for the first time; `certainty` and `decay_class` are text columns constrained by TS union types at the application layer, never a float; decay is computed only at query time — no cron, no stored/rewritten score; no `user_id` anywhere.

**Verified:** `npm run typecheck` and `npm test` (32 tests) both pass. Live-verified end-to-end against a real bot/Postgres/Ollama: a stated preference extracted into `memories` with `certainty='asserted'`, correct `subject`/`decay_class`; a contradicting correction ("Actually my favorite coffee order is a cortado now.") correctly flipped the old memory to `status='superseded'`, inserted the new one with `supersedes` pointing at it, and logged a `type='correction'` event; `/forget` produced a real approval card, Approve executed the deletion (`actions.status='done'`), and a separate Reject left the target memory untouched (`actions.status='rejected'`, still `active`).

Two real prompt-quality bugs were found and fixed during this live verification (not caught by unit tests, since those mock the LLM call): the capture classifier needed few-shot examples to reliably label plain factual statements as `fact` rather than `conversation`, and the memory-extraction prompt needed (a) an explicit rule to use `"user"` as the subject for self-referential facts — without it, `subject` defaulted to `null` and silently disabled the conflict-check entirely — and (b) worked examples of correction-phrased input, since the model was reading "actually... now" as conversational filler and returning `null` instead of extracting the updated fact.

---

## Milestone 3 — Gmail and Calendar read-only ingest ✅ implemented and live-verified

**Scope (PRD: ingest tables, entities, secrets handling):** OAuth, history-API polling, upsert-on-provider-id, entity extraction.

**Two deliberate deviations from the plan as originally drafted, decided with the user before writing code:**

1. **Direct Google API client instead of MCP.** The PRD calls for Gmail/Calendar to go through MCP clients, on the theory of reusing existing servers and swappability. Neither benefit materializes here: there's no verified, well-maintained third-party Gmail/Calendar MCP server to point at, and building our own MCP server just so Iris can be the only client of it is pure protocol ceremony with no functional gain. Iris talks to Gmail/Calendar directly via Google's official `googleapis` client library (`src/lib/google/`) — the same "MCP is the wrong boundary" reasoning the PRD already applies to internal state (memory/events/rules) applies here too; the real MCP boundary in this codebase is simply narrower than the PRD first sketched. If a genuinely reusable Gmail/Calendar MCP server shows up later, this is the layer that would get swapped.
2. **macOS `security` CLI instead of `keytar`.** `keytar` is archived/unmaintained upstream and needs a native compile step — exactly the kind of install friction Milestone 1/2 setup already hit repeatedly (Docker ports, Node version, Ollama). Since Iris runs on an actual Mac, shelling out to the same `security` binary Keychain Access.app itself uses (`src/lib/secrets.ts`) gets the OS-keychain requirement with zero new dependencies and no native-binding risk. The PRD's own fallback note (a headless/non-macOS environment needs an encrypted-file alternative) still applies if Iris ever runs somewhere else — not implemented, since it doesn't here.

**Files:**
- `src/lib/secrets.ts` — `security add-generic-password` / `find-generic-password` / `delete-generic-password` wrapper, one service name (`iris-agent`), keyed by account.
- `src/lib/google/auth.ts` — OAuth2 client construction, refresh-token load/save via `secrets.ts`, **read-only scopes only** (`gmail.readonly`, `calendar.readonly`).
- `src/scripts/google-auth-setup.ts` — one-time interactive consent flow: binds a local loopback server on an OS-assigned port (RFC 8252 native-app flow, works with a "Desktop app" OAuth client without pre-registering the port), prints the consent URL, exchanges the code, saves the refresh token.
- `src/lib/google/gmail.ts` — `parseMessage()` (pure, unit tested) plus `getCurrentHistoryId`/`listInitialMessageIds`/`listMessageIdsSince`/`getMessage`, each request bounded to 10s.
- `src/lib/google/calendar.ts` — `parseEvent()` (pure, unit tested) plus `listInitialEvents`/`listEventsSince`, same 10s bound. `timeMin` (initial backfill) and `syncToken` (incremental) are never combined in one request — Google's API rejects that.
- `src/lib/google/errors.ts` — `classifyGoogleError()` into the PRD's six-way taxonomy, pure and unit tested; `extractHttpStatus()` exported separately so callers can detect the specific 404 (Gmail) / 410 (Calendar) "watermark expired" cases precisely rather than only the general class.
- `src/lib/sync-state.ts` — `sync_state` watermark store; `recordSyncSuccess`/`recordSyncFailure` (message only) /`resetSyncState` (clears the stored value too, for the expired-watermark case).
- `src/lib/notify.ts` — sends a Telegram message directly via the Bot API (no long-poll bot instance needed) for alerts the worker raises on its own.
- `src/lib/entities.ts` — `classifySenderType()`, a deterministic keyword/domain heuristic (not a model call, matching invariant 8's spirit even though entity classification isn't a "rule" in the M5 sense) — unit tested, upgradeable to a model call later without touching anything downstream that reads `entity.type`.
- `src/worker/jobs/ingest-gmail.ts` / `ingest-calendar.ts` — poll on a 5-minute cron (`boss.schedule`), upsert on `message_id`/`provider_id` (Gmail: `onConflictDoNothing`, since email content is immutable once fetched; Calendar: `onConflictDoUpdate`, since events genuinely change — reschedules, cancellations), tag every resulting `events` row `untrusted: true`, notify on the *transition* into an auth failure (not every poll while it stays broken), and reset the watermark on an expired historyId/syncToken rather than retrying it forever.
- `src/worker/jobs/extract-entities.ts` — enqueued per new email, links `emails.entity_id`.
- `src/admin/server.ts` — two more views: `/emails`, `/health` (sync lag + last error per source, total ingest counts).

**Data model:** `emails`, `calendar_events`, `entities`, `relations` — matching the PRD's prose description — plus `sync_state` (not named in the PRD; a plain necessity for incremental sync and restart safety, storing each source's watermark, last success time, and last error).

**Cross-cutting landed here (easiest to silently drop):** every Gmail/Calendar-sourced `events` row gets `metadata.untrusted = true` at ingest time — nothing enforces on it until M6, but it can't be reconstructed later if skipped now. The failure-classification taxonomy becomes real; `auth` failures surface to Telegram immediately rather than letting ingest go silently quiet. External calls bounded at 10s.

**Verified:** `npm run typecheck` and `npm test` (54 tests, 22 new) both pass. Live-verified end-to-end against the user's real Google account: the OAuth consent flow completed on the first try and saved the refresh token to Keychain; the initial poll backfilled 25 real emails with zero errors; real recruiting emails (SmartRecruiters, Workday, Oracle/Goldman Sachs recruiting, Two Sigma) correctly classified as `entities.type='recruiter'` via the domain/keyword heuristic, non-recruiting senders correctly left `unknown`; every Gmail-sourced `events` row confirmed tagged `untrusted: true`; a forced redundant poll cycle left the email count at exactly 25 — no duplicates, confirming the upsert-on-`message_id` idempotency; Calendar ingest ran with zero errors and correctly returned 0 events, matching the user's actually-empty calendar (confirmed against the real Google Calendar UI, not assumed).

---

## Milestone 4 — Unified search ✅ implemented and live-verified

**Scope (PRD: embeddings, hybrid retrieval, ranking rule, definition-of-done):** this is where the MVP's cold-start test question first becomes answerable — "who was the recruiter... what did I decide about the rate."

**Files:**
- `src/lib/embeddings.ts` — `embedText()` via `@xenova/transformers` (`Xenova/all-MiniLM-L6-v2`, 384 dims, matching the schema's `vector(384)` columns), fully local, zero API cost; `chunkText()`, pure and unit tested, fixed-size chunking (deliberately simple — sentence-aware chunking is a future refinement, not needed to validate the pipeline).
- `src/lib/embed-store.ts` — `embedAndStoreChunks()`, shared by both the real-time job and the backfill script. Idempotent on `(source_table, source_id, chunk_index)`; also deletes any leftover tail chunks from a previous, longer embedding of the same source.
- `src/worker/jobs/embed.ts` — thin job wrapper, enqueued from `classify.ts` (for every captured message/transcript, not just facts — anything should be findable later) and from `ingest-gmail.ts` (per new email).
- `rememberFact()` in `memory.ts` now embeds the statement at write time, so every future memory is searchable immediately — no separate backfill needed going forward.
- `src/lib/retrieval.ts` — four legs merged: semantic search over `embeddings` (messages/emails), memory search over `memories.embedding` (status='active' only — see ranking rule below), structured `ILIKE` search over `emails`/`calendar_events` (catches exact terms embeddings can miss), and recent `events` for conversational context.
- `src/lib/ask.ts` — retrieved content goes into a clearly delimited `CONTEXT:` block with an explicit instruction that it is data, never a command — the first real use of the PRD's "structural separation" injection defense, established now even though nothing acts on model output yet (this matters specifically because Gmail-sourced content, tagged `untrusted` since M3, flows through this exact path).
- `src/worker/jobs/ask.ts` — enqueued from `bot/index.ts` for any message ending in `?` (a trivial, zero-cost string check — no model call, so it doesn't slow the "got it." ack), replies via `notify.ts`'s `sendMessage()` directly to the originating chat/thread.
- `src/scripts/backfill-embeddings.ts` — one-off, idempotent backfill for memories/events/emails ingested before this milestone existed. A real, necessary step, not optional: without it, everything from Milestones 1–3 (including the recruiter emails the definition-of-done question depends on) would be invisible to search.
- `src/eval/definition-of-done.ts` — runs the PRD's own cold-start question through `answerQuestion()` directly. This is eval case #1; the other 49+ the PRD wants can't be fabricated honestly without real data to check them against, so the set grows from here as real usage accumulates.
- `src/admin/server.ts` — `/ask` page to test the flow without going through Telegram.

**The ranking rule, implemented precisely:** "prefer the newest non-superseded fact over the most semantically similar one" is implemented as exclusion, not mere down-ranking — the memory leg's `status='active'` filter means a superseded memory can never surface via search at all, regardless of how semantically similar it is to the query. Within the remaining active set, `similarity * decayWeight` blends recency into the ranking so a long-decayed-but-technically-active memory doesn't outrank a fresher, equally relevant one.

**Data model:** `embeddings` table, exact DDL from the original plan (`source_table`, `source_id`, `chunk_index`, `content`, `vector(384)`, unique on the first three). `memories` keeps using its own `embedding` column directly — never duplicated into `embeddings`.

**Live-verified.** `npm run typecheck` and `npm test` pass throughout. Live verification against real Gmail/Telegram data surfaced and fixed several real bugs the type/unit checks couldn't catch:
- `gmail.ts`'s body-text extraction only undid the outer base64url transport encoding, never a part's own `Content-Transfer-Encoding: quoted-printable` — corrupting real email bodies (soft line breaks, `=XX` escapes, and — the subtler case — a sender emitting a literal multi-byte UTF-8 character on a part still labeled quoted-printable, which a string-based decode truncated into `U+FFFD`). Fixed by decoding at the byte level throughout.
- `retrieval.ts`'s structured email/calendar search `ILIKE`'d the entire raw question as one substring pattern — a dead code path for any real question. Now extracts keywords and ranks candidates by match count (recency alone let a flood of newer, barely-relevant emails crowd out an older, highly relevant one).
- Raw event text was being embedded into the `embeddings` table unconditionally, with no notion of supersession — correcting a fact (or hard-deleting one via `/forget`) left the old statement's raw text still searchable forever via the message leg, even though `memories` correctly excluded it. Fixed by purging a source event's embedding at the moment its memory is superseded or forgotten (`removeEmbedding()` in `embed-store.ts`), not just gating new embeds by the classifier's label (which can be inconsistent across near-duplicate messages).
- `ollamaGenerate()` never set a temperature, so identical questions against identical, verified-correct context produced visibly different answers across runs. Set to 0.1.
- `llama3.2` (3B) was unreliable at the Ask flow's multi-hop reasoning (e.g. connecting a paid NewtonX consulting engagement to "recruiter"/"contract role" from the PRD's own cold-start question) even with a strengthened system prompt. Switched the recommended default to `llama3.1:8b`, which answered consistently in testing.

`npm run backfill:embeddings` (idempotent, also repairs pre-fix data) and `npm run eval:dod` both confirmed working against real data; a real stated-then-corrected preference's search results correctly surface only the current value.

---

## Milestone 5 — Rules engine and nudges ✅ implemented and live-verified

**Scope (PRD: nudges DDL, three named detectors, cooldown/backoff, morning brief):**

**Files:**
- `src/worker/jobs/run-detectors.ts` — hourly cron, runs each enabled rule's SQL, logs to `rule_runs` (candidate count or error either way, so a quiet rule is distinguishable from a broken one).
- `src/lib/rules/detectors/recruiter-follow-up.ts`, `upcoming-interview.ts`, `unanswered-important-email.ts` — deterministic SQL only (invariant 8: rules operate without the model). Cooldown windows (`RECRUITER_FOLLOWUP_STALE_HOURS` / `UNANSWERED_EMAIL_STALE_HOURS`) are env-configurable, defaulting to 72h/48h.
- `src/lib/rules/relevance-filter.ts` — **one** model call per detector run reviewing the whole candidate batch, picking 0–3 — not one call per candidate.
- `src/lib/nudges.ts` — `proposeNudge()`: cooldown/backoff is structural, not a timer — a second undismissed nudge for the same (rule, subject) simply cannot be created, so "fires every morning for six days" is impossible by construction. Uses the DB partial unique index for entity-backed candidates, an app-level `dedupeKey` check (race-safe against a unique-violation) for the one rule with no entity to key off of.
- `src/worker/jobs/morning-brief.ts` — daily cron, posts today's calendar events plus any still-open nudges; sends nothing on a quiet day (invariant 9: silence is a valid success, never force a message to prove liveness).
- Debug UI gains a Nudges page: rules and their enabled state, active nudges with a one-click dismiss, and recent `rule_runs` history.

**Data model:** `nudges`, `rules`, `rule_runs`, all per the plan's original design, including the unique partial index on `(rule_id, entity_id) where dismissed = false`.

**Live-verified**, including one real judgment finding: the relevance filter reliably excludes explicit rejections, but on ambiguous automated recruiter emails it inconsistently selected cases where the sender explicitly said *they'd* follow up (not the person) — confirmed across three rounds of prompt strengthening (plain rule → explicit exclusion list → worked examples), the last of which the model responded to by hallucinating a worked example's text onto an unrelated real candidate. This is a firm reliability ceiling for the local model on this specific compound-judgment task, not a fixable prompt bug. One category (one-time passcodes/verification emails) was clear-cut enough to exclude deterministically at the SQL level instead of leaving it to model judgment — the remaining ambiguous cases are accepted as-is, mitigated by the nudge dismiss button, which costs one tap versus a fabricated fact costing trust.

Confirmed against real data: detector SQL correctly finds real candidates (verified by temporarily relaxing the cooldown window via its env var); `rule_runs` logs every pass; re-running an unchanged day produces zero duplicate nudges; dismissing a nudge correctly reopens the door for a fresh one if the same condition still holds on a later run (rather than either re-firing immediately or being suppressed forever); a real nudge delivers correctly over Telegram; the morning brief posts exactly the expected content when there's an open nudge, and stays completely silent when there's nothing to report.

---

## Milestone 6 — Action ledger and shadow mode (generalization, not birth) ✅ implemented, live-verification pending

**Scope:** generalizes M2's synchronous stand-in into the real architecture — separate Executor process, real approval cards, circuit breakers, the remaining permission-suite cases.

**Files:**
- `src/executor/index.ts` — third standalone process (`npm run dev:executor`); polls `actions` where `status='approved'` every 3s, executes via the registry, writes `result`/`status='done'`/`executed_at`, and sends a follow-up Telegram message describing the outcome (since execution is now async, the approval tap itself only confirms "executing shortly"). Reconciles rows stuck in `executing` at startup back to `approved` for re-pickup (restart-safety invariant).
- `src/lib/telegram-cards.ts` — real approval cards (tool, tier, args, rationale, untrusted warning, source snippet) sent via the Telegram Bot API directly (works from the executor/worker processes, not just the long-poll bot), with inline Approve/Reject buttons, replacing M2's throwaway inline confirm.
- `src/lib/untrusted-lineage.ts` — `isLineageUntrusted(eventId)` walks `metadata.sourceEventId` back through the chain (bounded depth, cycle-safe); if any ancestor event was tagged untrusted at ingest (M3), forces `untrusted=true` on the proposal regardless of tool tier (invariant 7).
- `src/bot/commands/approvals.ts` — generic `action:(approve|reject):<id>` callback handler, replacing `/forget`'s own bespoke one.
- `src/admin/server.ts` — sixth and final debug UI view, `/actions` (tool call audit: tool, tier, status, untrusted flag, rationale, args, result).

**Modified:** `src/lib/tools/policy-gate.ts` gained two circuit breakers, kept deliberately narrower than originally planned — a synchronous `IRIS_KILL_SWITCH` env-var check (forces every proposal to queue, whatever its tier) and an async, DB-backed `isFailureCircuitTripped()` (≥3 tool failures in the last hour trips it). The tier-2/hour cap and daily token budget sketched in the original plan were **deliberately not built**: they need usage-volume infrastructure (per-tool rate counters, a token-cost ledger) that doesn't exist yet and had no real traffic to size against at M6 — the kill switch plus failure-rate breaker cover the actual near-term risk (a tool that starts erroring repeatedly, or a need to freeze everything by hand) without inventing unused machinery. Revisit if real send volume in M7 shows a need. Predicate-based tier-2 auto-approval (contacts allowlist, thread-exists) was similarly deferred — it isn't needed until a write tool exists to auto-approve, so it lands with M7's tools directly (the autonomy-override mechanism, not a policy-gate predicate) rather than as separate dormant M6 plumbing.

**Tests:** `policy-gate.test.ts` gained kill-switch cases (forces queue regardless of tier; clears back to normal once unset).

**Verification (code-level, done):** `npm run typecheck` and `npm test` pass (85 tests, 13 files) with the new executor/lineage/kill-switch logic covered by unit tests where the logic is pure (lineage walking, kill switch), matching this project's established boundary of not unit-testing DB-touching orchestration.

**Verification (live, pending):** start the executor and confirm it logs "Iris executor is running."; run `/forget` end-to-end through the new async pipeline (approve → executor picks it up within ~3s → a separate completion message with the deletion count); kill the executor mid-execution and restart it — confirm the stuck row is reconciled back to `approved` and re-executed exactly once, never duplicated or lost; check the admin `/actions` page renders real rows correctly.

---

## Milestone 7 — First write actions ✅ implemented, live-verification pending

**Scope (PRD: write tools, egress allowlists, idempotency's hard case, undo, autonomy ladder):**

**Files:**
- `src/lib/google/auth.ts` — `GOOGLE_SCOPES` extended with `gmail.compose` and `calendar.events` alongside M3's read-only scopes. **Requires re-running `npm run google:auth-setup` to re-consent** — the existing refresh token predates these scopes and Google won't silently upgrade it.
- `src/lib/google/gmail.ts` — added `createDraftReply()` (builds a MIME reply within an existing thread, using the thread's own `In-Reply-To`/subject/recipient — never composes to an arbitrary new address), `getDraft()` (returns `null` on a 404, which is later used as proof-of-send), `getDraftRecipient()`, `sendDraft()`, `deleteDraft()`.
- `src/lib/google/calendar.ts` — added `createEvent()`, `deleteEvent()`.
- `src/lib/tools/gmail-write.ts` — `gmail.create_draft(threadId, body)`, tier 1 auto, scoped to replying within an existing thread only; `gmail.send_draft(draftId)`, tier 2 approval, re-fetches the draft at execution time and refuses to send if it no longer exists, and enforces the contacts allowlist **inside the handler itself** (not just as an earlier advisory gate check), so a forced or manipulated approval still can't bypass it.
- `src/lib/tools/calendar-write.ts` — `calendar.create_event(...)`, tier 2 approval.
- `src/lib/contacts-allowlist.ts` — `isAllowedRecipient(address)`: true only if that address has previously sent the user an email (per `emails.from_address`). Since `gmail.create_draft` only ever replies within existing threads, every legitimate draft recipient is by construction someone already in this allowlist.
- `src/lib/undo.ts` — `finalizeUndoPayload(tool, result)`, populated **after** successful execution (it needs the real draft/event ID the API returned, which doesn't exist at proposal time) — `gmail.create_draft` → delete the draft; `calendar.create_event` → delete the event; `gmail.send_draft` → `null` (no API to unsend a sent email). `performUndo(action)` executes the actual reversal; wired into a new Undo button on the admin `/actions` page.
- `src/lib/autonomy.ts` — the ladder, asymmetric by design per the "never self-promote" requirement: `checkAutonomyPromotion(tool)` at ≥30 decided proposals with ≥95% approval only **offers** automation via a Telegram message (never applies it); `checkAutonomyDemotion(tool)` automatically clears an existing override if the 3 most-recent decisions for that tool were all rejections (reverting to more oversight needs no permission). New `tool_autonomy_overrides(tool text primary key, level smallint, updated_at timestamptz)` table, consulted by `policy-gate.ts`'s new `tierOverride` param ahead of the tool's static tier — checked only after the kill switch and untrusted-lineage forcing, never able to widen past what those already force.
- `src/bot/commands/autonomy.ts` — `/autonomy <tool> <on|off>`, the human's explicit accept/decline of a promotion offer.
- `src/executor/index.ts` — idempotency's hard case: `reconcileStuckSendDraft()` handles a `gmail.send_draft` action found `executing` at startup by calling `getDraft()`; a `null` result (404) is definitive proof the send already succeeded before a crash, so the row is marked `done` directly without resending; if the check itself errors, the row is left `executing` for manual review rather than guessing.
- `src/lib/tools/policy-gate.test.ts` — new cases for the two newly-registered tools (`gmail.send_draft`/`calendar.create_event` → queued; `gmail.create_draft` → auto-approved; `gmail.create_draft` with untrusted lineage → queued despite being tier 1). One pre-existing test that had used `gmail.send_draft` as a stand-in for "an unregistered tool" was fixed to use a genuinely unregistered name instead, since the tool is now real.

**Verification (code-level, done):** `npm run typecheck` and `npm test` pass (85 tests, 13 files).

**Verification (live, pending — requires the person's explicit go-ahead before the real-send step):** re-run `npm run google:auth-setup` for the new write scopes; create a real draft via `gmail.create_draft` and confirm it appears in the real Gmail account; propose `gmail.send_draft` and confirm a real approval card appears — **before tapping Approve on an actual send, confirm explicitly that sending a real, externally-visible, unrecoverable email to a real recipient is wanted**, since this is not reversible the way every other milestone's verification has been; separately test the egress allowlist by attempting to send to a non-allowlisted address (must be refused at execution, not just at proposal); create a real calendar event via `calendar.create_event`; exercise Undo on a created draft and/or event via the admin UI; test `IRIS_KILL_SWITCH=true` forcing everything to queue. The autonomy ladder's promotion path can't be practically exercised without 30 real decided proposals accumulating over real usage — it can only be verified functionally now (it never fires early), not for its actual trigger-at-30 behavior.

**Then, explicitly out of MVP scope (noted for continuity only):** career lens as a config object (`/career` toggles instructions/tool-subset/memory-scope, same runtime — "lenses, not sub-agents"), web research (new MCP client, isolated browsing profile), document/PDF ingestion (feeds M4's embeddings pipeline). Reservations, finances, health, and a dashboard stay fully out of scope.

---

## Debug UI rollout (incremental, not a big-bang build)

| Milestone | Views added |
|---|---|
| M2 | recent events, memory search/inspection |
| M3 | + Gmail/Calendar sync lag (system health, partial) |
| M5 | + rule run history, active watches, system health completed |
| M6 | + tool call audit (final view, 6/6) — shipped: `/actions`, with an Undo column added in M7 |

## Permission test suite rollout

| Milestone | Cases added |
|---|---|
| M2 | `memory.forget` DENY without approval; `memory.search` ALLOW; unregistered-tool → DENY |
| M6 | `IRIS_KILL_SWITCH` forces queue regardless of tier; clears back to normal tier behavior once unset |
| M7 | `gmail.send_draft`/`calendar.create_event` → queued (tier 2); `gmail.create_draft` → auto-approved (tier 1); `gmail.create_draft` with untrusted lineage → queued despite tier 1 |

## Cross-cutting requirements — where each lands

| Requirement | Lands at |
|---|---|
| Tool registry + tiers + policy gate | M2 (pulled forward from M6) |
| Idempotency keys | M2 (derivation) → M6 (checked in executor) → M7 (hard exactly-once case) |
| Fail-closed gate | M2 |
| `trace_id` / observability | M1 (seeded) → M4 (full retrieval chain) → M6 (action lifecycle) |
| Secrets in OS keychain | M3 |
| Untrusted lineage tagged / enforced | M3 (tagged) → M6 (enforced) |
| Egress allowlists at executor | M7 |
| Idempotency check + result in one transaction | M6 (plumbing) → M7 (real reconciliation case) |
| Cooldown/backoff on nudges | M5 |
| Decay at query time, never stored | M2 |
| Certainty as ordinal, not float | M2 |
| No `user_id` / no `users` table | Every migration — treat as a standing check |
| MCP boundary limited to Gmail/Calendar/web search | Revised at M3 — no MCP used at all (direct Google API client instead, see M3's write-up); reassess if web research (M7+) turns out to have a real MCP server worth using |

## Invariants tracking

The 12 invariants aren't a separate milestone — they're satisfied incrementally (7 at M3/M6, 5 & 6 at M2/M6/M7, 8 & 9 at M5, 12 at M7, etc.) and should be re-checked as a checklist at the end of every milestone, not just once at the end.

## Overall verification

Each milestone section above has its own concrete test. The two checkpoints that matter most across the whole plan: the definition-of-done question must resolve correctly once M4 ships on top of M3+M1/M2 data (M4 verification), and the permission test suite must stay green on every commit from M2 onward — a regression there is called out in the PRD as the one class of bug able to do real damage.

## Next step

Live-verify Milestones 6 and 7 together on the person's real Mac (real Postgres, real Ollama, real Telegram bot, real Google account) — code-level verification (`typecheck`/`test`) is already green for both. Concretely: start the executor (`npm run dev:executor`) and confirm the async `/forget` pipeline and restart-safety; re-run `npm run google:auth-setup` for the new Gmail/Calendar write scopes; exercise `gmail.create_draft`, `calendar.create_event`, the egress allowlist refusal, and Undo. The one step requiring explicit prior go-ahead, not just a code review, is actually approving a real `gmail.send_draft` — it sends a real, externally-visible, unrecoverable email — so confirm that specifically before tapping Approve on it. Once both milestones are live-verified, update their status here and in `README.md` to "implemented and live-verified," matching every prior milestone.
