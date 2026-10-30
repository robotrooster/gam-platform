import { AppError } from '../../middleware/errorHandler'
import { logger } from '../../lib/logger'

/**
 * Agent engine — model connection config.
 *
 * The engine talks to any OpenAI-compatible endpoint. The models are
 * self-hosted ONLY ("no third-party AI API, no tenant data leaving
 * GAM-controlled hardware"). The 2026-09-06 plan to override that for the
 * GCP migration was withdrawn on 2026-10-29 (Nic): the API may run in GAM's
 * own GCP project, but the chat and embeddings models stay on GAM's Mac
 * (MLX Hermes :8080, bge-large :8081), reached from the cloud through
 * Cloudflare Access-protected tunnel hostnames — see GCP_MIGRATION_PLAN.md
 * Phase A4. Dev runs the same servers on localhost.
 *
 * Required env:
 *   - LLM_ENDPOINT  OpenAI-compatible base, e.g. http://localhost:8080/v1
 *   - LLM_MODEL     served model id, e.g. mlx-community/Hermes-4-14B-4bit
 * Optional env:
 *   - CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET  Cloudflare Access
 *                     service token for the tunnel hostnames (cloud only)
 *   - LLM_API_KEY     bearer token (absent = no header)
 *   - LLM_TIMEOUT_MS  per-request timeout; defaults to 180s (a local
 *                     model on modest hardware can be slow to first token)
 */

/**
 * Cloudflare Access service-token headers (GCP migration Phase A4): from
 * Cloud Run the model servers are reached through Access-protected tunnel
 * hostnames, which refuse any request without the token. Absent vars = no
 * headers — localhost on the Mac needs none.
 */
export function cfAccessHeaders(): Record<string, string> {
  const id = process.env.CF_ACCESS_CLIENT_ID
  const secret = process.env.CF_ACCESS_CLIENT_SECRET
  return id && secret ? { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret } : {}
}

/**
 * Auth headers for a model server: the Cloudflare Access token when set,
 * plus an optional bearer key (EMBEDDINGS_API_KEY falls back to
 * LLM_API_KEY). The local MLX servers take neither, so absent vars mean no
 * headers — behavior unchanged on the Mac.
 */
export function llmAuthHeaders(keyVar: 'LLM_API_KEY' | 'EMBEDDINGS_API_KEY'): Record<string, string> {
  const key = process.env[keyVar] || process.env.LLM_API_KEY
  return { ...cfAccessHeaders(), ...(key ? { Authorization: `Bearer ${key}` } : {}) }
}

/** Parse a comma-separated endpoint list (preferred, for a worker fleet)
 *  falling back to a single endpoint var. Trailing slashes stripped,
 *  blanks dropped. Throws if neither is set. */
function parseEndpoints(listVar: string, singleVar: string): string[] {
  const raw = process.env[listVar] || process.env[singleVar]
  // AppError(503), not a plain Error: an unconfigured model endpoint means
  // "the assistant is unavailable on this deployment", not a server bug —
  // agent routes must answer 503, never 500 (GCP migration Phase A4). The
  // env-var specifics stay in the log, not the client message.
  if (!raw) {
    logger.warn({ var: listVar }, 'agent engine unconfigured — endpoint env not set')
    throw new AppError(503, 'The assistant is not available right now.')
  }
  const endpoints = raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
  if (endpoints.length === 0) {
    logger.warn({ var: listVar }, 'agent engine unconfigured — endpoint env empty')
    throw new AppError(503, 'The assistant is not available right now.')
  }
  return endpoints
}

export interface LlmConfig {
  /** OpenAI-compatible base URLs of the chat-model worker fleet. The app
   *  spreads load across these; the dev team adds workers via LLM_ENDPOINTS. */
  endpoints: string[]
  /** served model id */
  model: string
  /** per-request timeout in ms */
  timeoutMs: number
  /** max tokens to generate per call. Must leave room for a tool call to
   *  follow any preamble text, or the model gets cut off mid-thought. */
  maxTokens: number
}

/**
 * Reads the model connection from env. Throws at call time (not at
 * import) so the rest of the API still boots when the agent engine
 * is unconfigured — only agent requests fail, matching how
 * lib/stripe.ts gates on STRIPE_SECRET_KEY.
 */
export function getLlmConfig(): LlmConfig {
  const endpoints = parseEndpoints('LLM_ENDPOINTS', 'LLM_ENDPOINT')
  const model = process.env.LLM_MODEL
  if (!model) {
    logger.warn('agent engine unconfigured — LLM_MODEL not set')
    throw new AppError(503, 'The assistant is not available right now.')
  }

  // 180s default: a 36B at 6-bit can take >60s on a long generation (e.g. a full
  // portal walkthrough), which previously timed out and surfaced an error.
  const rawTimeout = Number(process.env.LLM_TIMEOUT_MS)
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 180_000

  const rawMaxTokens = Number(process.env.LLM_MAX_TOKENS)
  // S650: 1024 → 600. Replies are one to three sentences and the longest
  // legitimate output is a drafted notice (~300-400 tokens). The model writes
  // ~18 tokens/s here, and a benchmark turn ran away to the full 1024 — 75 s of
  // text that was thrown away. 600 still fits any real reply or tool call.
  const maxTokens = Number.isFinite(rawMaxTokens) && rawMaxTokens > 0 ? rawMaxTokens : 600

  return { endpoints, model, timeoutMs, maxTokens }
}

/**
 * Embedding model connection — a SECOND OpenAI-compatible endpoint
 * (separate from the chat model). Dev runs bge-large-en-v1.5 via
 * llama.cpp on localhost:8081. Hosted providers permitted per the same
 * override as the chat model above; keep the SAME embedding model
 * wherever it runs — see EMBEDDING_DIM.
 *
 * Required env:
 *   - EMBEDDINGS_ENDPOINT  e.g. http://localhost:8081/v1
 *   - EMBEDDINGS_MODEL     e.g. bge-large-en-v1.5
 */

/**
 * Dimension of the embedding vectors. LOCKED to bge-large-en-v1.5 and
 * MUST match the vector(N) width in the agent_knowledge_store migration.
 * Changing the embedding model means a new migration + re-embedding
 * every stored chunk.
 */
export const EMBEDDING_DIM = 1024

export interface EmbeddingsConfig {
  /** OpenAI-compatible base URLs of the embedding-model worker fleet. */
  endpoints: string[]
  model: string
  timeoutMs: number
}

export function getEmbeddingsConfig(): EmbeddingsConfig {
  const endpoints = parseEndpoints('EMBEDDINGS_ENDPOINTS', 'EMBEDDINGS_ENDPOINT')
  const model = process.env.EMBEDDINGS_MODEL
  if (!model) {
    logger.warn('agent engine unconfigured — EMBEDDINGS_MODEL not set')
    throw new AppError(503, 'The assistant is not available right now.')
  }

  const rawTimeout = Number(process.env.EMBEDDINGS_TIMEOUT_MS)
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 30_000

  return { endpoints, model, timeoutMs }
}

/**
 * Sampler settings sent with each completion. A profile may override
 * any subset of these.
 */
export interface SamplerSettings {
  temperature: number
  top_p: number
  top_k: number
  /** stop sequences; the Hermes ChatML turn terminator lives here */
  stop: string[]
}

/**
 * Nous Research's recommended Hermes 4 sampler defaults. These
 * specifically prevent the degenerate looping Hermes falls into with
 * greedy/over-penalized sampling. min_p and repeat-penalty are left
 * OFF (omitted from the request) per the same guidance.
 */
export const HERMES_SAMPLER_DEFAULTS: SamplerSettings = {
  temperature: 0.6,
  top_p: 0.95,
  top_k: 20,
  stop: ['<|im_end|>'],
}
