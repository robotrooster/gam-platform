/**
 * scrubExpiredTenantContent — scrubs only old TENANT verbatim content,
 * keeps metrics, never touches landlord rows. DB mocked.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../../db', () => ({ query: vi.fn() }))

import { query } from '../../db'
import { scrubExpiredTenantContent } from './retention'

const mockQuery = query as unknown as ReturnType<typeof vi.fn>

describe('scrubExpiredTenantContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('updates only tenant rows past the retention window, skipping already-scrubbed', async () => {
    mockQuery.mockResolvedValue([{ id: 'a' }, { id: 'b' }])
    const n = await scrubExpiredTenantContent()

    expect(n).toBe(2)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/audience = 'tenant'/)
    expect(sql).toMatch(/agent_reply <> \$2/) // skip already-scrubbed
    expect(sql).toMatch(/human_handoff = NULL/)
    expect(params[0]).toBe(365) // default retention days
    expect(params[1]).toBe('[scrubbed]')
  })

  it('honors AGENT_TENANT_CONTENT_RETENTION_DAYS', async () => {
    process.env.AGENT_TENANT_CONTENT_RETENTION_DAYS = '730'
    mockQuery.mockResolvedValue([])
    await scrubExpiredTenantContent()
    expect(mockQuery.mock.calls[0][1][0]).toBe(730)
    delete process.env.AGENT_TENANT_CONTENT_RETENTION_DAYS
  })

  it('preserves landlord content (query is scoped to tenant audience only)', async () => {
    mockQuery.mockResolvedValue([])
    await scrubExpiredTenantContent()
    expect(mockQuery.mock.calls[0][0]).not.toMatch(/landlord/)
  })
})
