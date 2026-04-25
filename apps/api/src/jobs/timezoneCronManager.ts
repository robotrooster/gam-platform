// apps/api/src/jobs/timezoneCronManager.ts
// S26b-tz: Per-property-timezone cron registration manager.
//
// Engines that need to fire at a specific local hour (late fees at midnight,
// invoice generation at 7am) register through here instead of running a
// global hourly cron with timezone-aware SQL filters.
//
// At init: query distinct properties.timezone values, register one cron
// per timezone per engine. Each cron uses node-cron's `timezone` option,
// which handles DST automatically.
//
// At 3am UTC daily refresh: re-query, diff old vs new set, register added
// timezones, unregister timezones no longer in use, leave existing alone.
//
// Each engine owns its own Map<string, ScheduledTask> keyed by IANA tz.

import * as cron from 'node-cron'
import type { ScheduledTask } from 'node-cron'
import { query } from '../db'

export type EngineId = 'lateFees' | 'invoices'

interface EngineConfig {
  /** IANA cron expression, evaluated in the property's local timezone. */
  cronExpr: string
  /** Function to invoke when the cron fires for properties in tz. */
  handler: (tz: string) => Promise<void>
  /** Human label for log roll-up. */
  label: string
}

const engines = new Map<EngineId, EngineConfig>()
const cronsByEngine = new Map<EngineId, Map<string, ScheduledTask>>()

/**
 * Register an engine. Call once per engine at scheduler init,
 * BEFORE calling refreshTimezoneCrons().
 */
export function registerEngine(id: EngineId, config: EngineConfig): void {
  engines.set(id, config)
  if (!cronsByEngine.has(id)) {
    cronsByEngine.set(id, new Map())
  }
}

/**
 * Query distinct timezones currently in use across properties.
 * Returns sorted array for deterministic iteration.
 */
async function activeTimezones(): Promise<string[]> {
  const rows = await query<{ timezone: string }>(
    `SELECT DISTINCT timezone FROM properties WHERE timezone IS NOT NULL ORDER BY timezone`
  )
  return rows.map(r => r.timezone)
}

/**
 * Diff currently-registered crons against active timezones. Register new,
 * unregister removed, leave existing alone. Idempotent — safe to call
 * repeatedly.
 */
export async function refreshTimezoneCrons(): Promise<{
  added: { engine: EngineId; tz: string }[]
  removed: { engine: EngineId; tz: string }[]
}> {
  const added: { engine: EngineId; tz: string }[] = []
  const removed: { engine: EngineId; tz: string }[] = []

  const activeTzs = await activeTimezones()
  const activeSet = new Set(activeTzs)

  for (const [engineId, config] of engines.entries()) {
    const tasks = cronsByEngine.get(engineId)!

    // Unregister timezones no longer in active set.
    for (const [tz, task] of tasks.entries()) {
      if (!activeSet.has(tz)) {
        task.stop()
        tasks.delete(tz)
        removed.push({ engine: engineId, tz })
      }
    }

    // Register timezones newly in active set.
    for (const tz of activeTzs) {
      if (tasks.has(tz)) continue
      const task = cron.schedule(
        config.cronExpr,
        async () => {
          try {
            await config.handler(tz)
          } catch (e) {
            console.error(`[TzCron][${engineId}][${tz}] handler error:`, e)
          }
        },
        { timezone: tz }
      )
      tasks.set(tz, task)
      added.push({ engine: engineId, tz })
    }
  }

  return { added, removed }
}

/**
 * Register the daily refresh cron itself. Runs at 3am UTC.
 * Call once at scheduler init AFTER all engines are registered.
 */
export function registerRefreshCron(): void {
  cron.schedule('0 3 * * *', async () => {
    try {
      const { added, removed } = await refreshTimezoneCrons()
      if (added.length > 0 || removed.length > 0) {
        console.log(
          `[TzCron] Refresh: +${added.length} added, -${removed.length} removed`
        )
      }
    } catch (e) {
      console.error('[TzCron] Refresh error:', e)
    }
  })
}

/**
 * Roll-up summary for scheduler init logs.
 * Returns {engineId: timezoneCount} after current registration state.
 */
export function summary(): Record<EngineId, { tzCount: number; label: string }> {
  const result: Record<string, { tzCount: number; label: string }> = {}
  for (const [engineId, config] of engines.entries()) {
    result[engineId] = {
      tzCount: cronsByEngine.get(engineId)?.size ?? 0,
      label: config.label,
    }
  }
  return result as Record<EngineId, { tzCount: number; label: string }>
}
