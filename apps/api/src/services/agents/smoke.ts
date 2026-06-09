/**
 * Live smoke for the agent engine (Step 1).
 *
 * Hits the REAL self-hosted endpoint — run it to confirm the engine
 * round-trips against Hermes. Not part of the vitest suite (that's
 * mocked); this is a manual check.
 *
 *   LLM_ENDPOINT=http://localhost:8080/v1 \
 *   LLM_MODEL=mlx-community/Hermes-4-14B-4bit \
 *   node -r ts-node/register src/services/agents/smoke.ts
 *
 * Falls back to those same defaults if the env vars are unset, so a
 * bare `node -r ts-node/register src/services/agents/smoke.ts` works
 * in dev.
 */

import { runAgent } from './engine'
import { requireProfile } from './profiles'

process.env.LLM_ENDPOINT ||= 'http://localhost:8080/v1'
process.env.LLM_MODEL ||= 'mlx-community/Hermes-4-14B-4bit'

// Exercises a REAL registry profile. Override with the first CLI arg,
// e.g. `... smoke.ts landlord_entry "where's my payout?"`.
const KNOWN_IDS = ['tenant_entry', 'tenant_escalation', 'landlord_entry', 'landlord_escalation']
const maybeId = process.argv[2]
const profileId = maybeId && KNOWN_IDS.includes(maybeId) ? maybeId : 'tenant_entry'
const profile = requireProfile(profileId)

async function main() {
  const argsAfterId = maybeId && KNOWN_IDS.includes(maybeId) ? 3 : 2
  const message = process.argv.slice(argsAfterId).join(' ') || 'Hi, when is my rent due?'
  console.log(`\n[smoke] endpoint = ${process.env.LLM_ENDPOINT}`)
  console.log(`[smoke] model    = ${process.env.LLM_MODEL}`)
  console.log(`[smoke] profile  = ${profile.label}`)
  console.log(`[smoke] user     > ${message}\n`)

  const t0 = Date.now()
  const result = await runAgent({ profile, message })
  const ms = Date.now() - t0

  console.log(`[smoke] agent    > ${result.reply}\n`)
  console.log(
    `[smoke] done in ${ms}ms` +
      (result.usage
        ? ` — ${result.usage.promptTokens ?? '?'} prompt / ${
            result.usage.completionTokens ?? '?'
          } completion tokens`
        : '')
  )
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err.message)
  process.exit(1)
})
