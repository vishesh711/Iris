-- pgvector is needed starting with the embeddings table (Milestone 4),
-- but enabling it here avoids a migration surprise later.
CREATE EXTENSION IF NOT EXISTS vector;
