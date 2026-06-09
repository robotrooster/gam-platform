-- Agent knowledge store (customer-service AI agents, Step 3 / RAG layer).
--
-- WHY: the agent engine must answer from real GAM knowledge, never from
-- the language model's invention. This table is the retrieval corpus:
-- chunks of help/policy/how-to content, each stored with a vector
-- embedding so the engine can pull the most relevant chunks for a
-- question and ground its reply in them.
--
-- Embeddings are produced by a SELF-HOSTED bge-large-en-v1.5 model
-- (1024-dim) served via llama.cpp on GAM hardware — no third-party AI
-- API, no per-token cost, no data leaving GAM (CLAUDE.md hard rule).
-- The vector(1024) width below is locked to that model; the matching
-- constant lives at services/agents/config.ts EMBEDDING_DIM. Changing
-- the embedding model means a new migration + re-embedding every row.
--
-- `scope` tags which knowledge slice a chunk belongs to so retrieval
-- can be scoped per agent profile (a tenant agent reads tenant+shared,
-- a landlord agent reads landlord+shared). Values are the single source
-- KNOWLEDGE_SCOPES in services/agents/types.ts — keep this CHECK in sync.
--
-- NO BACKFILL NEEDED: new table, starts empty. The content-ingestion
-- layer (deferred per handoff) populates it later via the indexChunk()
-- interface in services/agents/knowledge.ts.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE agent_knowledge_chunks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- which knowledge slice this chunk belongs to; scoped per profile
  scope      text NOT NULL CHECK (scope IN ('tenant', 'landlord', 'shared')),
  -- provenance: the document / article / source this chunk came from
  source     text,
  title      text,
  -- the chunk text the model reads
  content    text NOT NULL,
  -- bge-large-en-v1.5 embedding of `content` (1024-dim, see EMBEDDING_DIM)
  embedding  vector(1024) NOT NULL,
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Scope filter is applied on every retrieval; index it.
CREATE INDEX agent_knowledge_chunks_scope_idx
  ON agent_knowledge_chunks (scope);

-- Approximate-nearest-neighbor index for cosine similarity search.
-- HNSW gives high recall with low query latency; cosine matches how
-- bge embeddings are compared (normalized, angular distance).
CREATE INDEX agent_knowledge_chunks_embedding_idx
  ON agent_knowledge_chunks
  USING hnsw (embedding vector_cosine_ops);
