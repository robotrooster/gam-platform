/**
 * Agent engine — model connection config.
 *
 * The engine talks to a self-hosted, OpenAI-compatible LLM endpoint
 * ONLY. No third-party AI API, no per-token cost, no tenant data
 * leaving GAM-controlled hardware (CLAUDE.md hard rule). Dev runs
 * Hermes-4-14B (4-bit) via MLX on localhost:8080; prod swaps a larger
 * Hermes behind the same endpoint. Because BOTH the URL and the model
 * name are env-driven, dev->prod and machine->machine is a config
 * change, never an engine rebuild.
 *
 * Required env:
 *   - LLM_ENDPOINT  OpenAI-compatible base, e.g. http://localhost:8080/v1
 *   - LLM_MODEL     served model id, e.g. mlx-community/Hermes-4-14B-4bit
 * Optional env:
 *   - LLM_TIMEOUT_MS  per-request timeout; defaults to 60s (a local
 *                     model on modest hardware can be slow to first token)
 */

/** Parse a comma-separated endpoint list (preferred, for a worker fleet)
 *  falling back to a single endpoint var. Trailing slashes stripped,
 *  blanks dropped. Throws if neither is set. */
function parseEndpoints(listVar: string, singleVar: string): string[] {
  const raw = process.env[listVar] || process.env[singleVar]
  if (!raw) throw new Error(`${listVar} (or ${singleVar}) not set`)
  const endpoints = raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
  if (endpoints.length === 0) throw new Error(`${listVar} (or ${singleVar}) is empty`)
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
  if (!model) throw new Error('LLM_MODEL not set')

  const rawTimeout = Number(process.env.LLM_TIMEOUT_MS)
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 60_000

  const rawMaxTokens = Number(process.env.LLM_MAX_TOKENS)
  const maxTokens = Number.isFinite(rawMaxTokens) && rawMaxTokens > 0 ? rawMaxTokens : 1024

  return { endpoints, model, timeoutMs, maxTokens }
}

/**
 * Embedding model connection — a SECOND self-hosted, OpenAI-compatible
 * endpoint (separate from the chat model). Dev runs bge-large-en-v1.5
 * via llama.cpp on localhost:8081. Same no-third-party rule applies.
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
  if (!model) throw new Error('EMBEDDINGS_MODEL not set')

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
