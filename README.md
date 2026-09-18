# Iris

A personal agent that holds context durably — decisions, preferences, commitments — and acts on it, under supervision, from a single Telegram interface.

Full design: [`docs/PRD.md`](docs/PRD.md).

## Status

Milestone 0: the Telegram bot writes every incoming message to the `events` ledger in Postgres and replies "got it." Everything else in the PRD builds on this.

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
4. Run the bot:
   ```
   npm run dev:bot
   ```

Message the bot on Telegram — it should reply "got it." and the message should land as a row in the `events` table.

## Layout

- `src/bot` — Telegram long-poll process. Writes events, acknowledges, does no reasoning.
- `src/db` — Drizzle schema and Postgres client.
- `src/lib` — Shared core library (event ledger writes, and future memory/policy code).
- `docker/` — Local Postgres + pgvector setup.
- `docs/` — Design docs.
