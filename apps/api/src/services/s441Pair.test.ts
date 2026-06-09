/**
 * S441 services-audit pair slice.
 *
 *   - backgroundProvider.ts (359 lines): MockProvider +
 *     CheckrProvider implementations + getProvider dispatch.
 *     The Checkr adapter is the S420 live HTTP integration;
 *     fetch is stubbed to exercise both happy + failure branches.
 *   - subleaseDocuments.ts (388 lines): S251 sublease agreement
 *     generator + completion executor; pdf-lib roundtrip on the
 *     default template path; email module mocked.
 *
 * No triplet this time — the Stripe state-machine continuation
 * halves are deferred to a dedicated slice.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import crypto from 'crypto'
import * as fs from 'fs'
import { PDFDocument } from 'pdf-lib'

const { emailSigningRequestMock } = vi.hoisted(() => ({
  emailSigningRequestMock: vi.fn(async () => undefined),
}))

vi.mock('./email', () => ({
  emailSigningRequest: emailSigningRequestMock,
}))

import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import {
  getProvider, listProviderNames,
} from './backgroundProvider'
import {
  generateSubleaseDocument, executeSubleaseAgreementCompletion,
} from './subleaseDocuments'

beforeEach(async () => {
  await cleanupAllSchema()
  emailSigningRequestMock.mockReset()
})

// ═════════════════════════ backgroundProvider ═════════════════════════

describe('backgroundProvider', () => {
  describe('getProvider + listProviderNames', () => {
    it('null/undefined defaults to mock', () => {
      expect(getProvider().name).toBe('mock')
      expect(getProvider(null).name).toBe('mock')
    })

    it('"mock" returns MockProvider; "checkr" returns CheckrProvider', () => {
      expect(getProvider('mock').name).toBe('mock')
      expect(getProvider('checkr').name).toBe('checkr')
    })

    it('case-insensitive lookup', () => {
      expect(getProvider('CHECKR').name).toBe('checkr')
    })

    it('unknown provider → throws', () => {
      expect(() => getProvider('experian')).toThrow(/Unknown background provider/)
    })

    it('listProviderNames returns the registry', () => {
      const names = listProviderNames()
      expect(names).toContain('mock')
      expect(names).toContain('checkr')
    })
  })

  describe('MockProvider', () => {
    const sampleReq = {
      backgroundCheckId: 'bc1', firstName: 'A', lastName: 'B',
      email: 'a@b.com', dateOfBirth: '1990-01-01', ssnLast4: '1234',
      street1: '1 Main', city: 'Phx', state: 'AZ', zip: '85001',
      consentCredit: true, consentCriminal: true,
    }

    it('initiate: missing consent → failed result with reason', async () => {
      const provider = getProvider('mock')
      const r = await provider.initiate({ ...sampleReq, consentCredit: false })
      expect(r.status).toBe('failed')
      expect(r.failureReason).toMatch(/missing required consents/)
      expect(r.providerRef).toBe('')
    })

    it('initiate happy → providerRef + awaiting_applicant', async () => {
      const provider = getProvider('mock')
      const r = await provider.initiate(sampleReq)
      expect(r.status).toBe('awaiting_applicant')
      expect(r.providerRef).toMatch(/^mock_[0-9a-f]+$/)
    })

    it('verifyWebhook: no env secret → returns true (dev convenience)', () => {
      const prior = process.env.BACKGROUND_MOCK_WEBHOOK_SECRET
      delete process.env.BACKGROUND_MOCK_WEBHOOK_SECRET
      try {
        const provider = getProvider('mock')
        expect(provider.verifyWebhook({}, '{"x":1}')).toBe(true)
      } finally {
        if (prior !== undefined) process.env.BACKGROUND_MOCK_WEBHOOK_SECRET = prior
      }
    })

    it('verifyWebhook: env secret + valid HMAC → true', () => {
      process.env.BACKGROUND_MOCK_WEBHOOK_SECRET = 'shh'
      try {
        const body = '{"providerRef":"x","status":"complete"}'
        const sig = crypto.createHmac('sha256', 'shh').update(body).digest('hex')
        const provider = getProvider('mock')
        expect(provider.verifyWebhook({ 'x-mock-signature': sig }, body)).toBe(true)
      } finally {
        delete process.env.BACKGROUND_MOCK_WEBHOOK_SECRET
      }
    })

    it('verifyWebhook: bad signature → false', () => {
      process.env.BACKGROUND_MOCK_WEBHOOK_SECRET = 'shh'
      try {
        const body = '{"x":1}'
        const wrong = crypto.createHmac('sha256', 'shh').update('other').digest('hex')
        const provider = getProvider('mock')
        expect(provider.verifyWebhook({ 'x-mock-signature': wrong }, body)).toBe(false)
      } finally {
        delete process.env.BACKGROUND_MOCK_WEBHOOK_SECRET
      }
    })

    it('parseWebhook: maps status, stamps receivedAt; preserves payload fields', () => {
      const provider = getProvider('mock')
      const update = provider.parseWebhook(JSON.stringify({
        providerRef: 'r1', status: 'completed',
        reportSummary: { score: 80 },
      }))
      expect(update.providerRef).toBe('r1')
      expect(update.status).toBe('complete')  // 'completed' → 'complete'
      expect(update.reportSummary).toEqual({ score: 80 })
      expect(update.receivedAt).toBeInstanceOf(Date)
    })

    it('parseWebhook: unknown status → failed (defensive)', () => {
      const provider = getProvider('mock')
      const update = provider.parseWebhook(JSON.stringify({
        providerRef: 'r1', status: 'who_knows',
      }))
      expect(update.status).toBe('failed')
    })

    it('craDisclosure flagged as development placeholder', () => {
      expect(getProvider('mock').craDisclosure().name).toMatch(/development only/i)
    })
  })

  describe('CheckrProvider', () => {
    const sampleReq = {
      backgroundCheckId: 'bc1', firstName: 'A', lastName: 'B',
      email: 'a@b.com', dateOfBirth: '1990-01-01', ssnLast4: '1234',
      street1: '1 Main', city: 'Phx', state: 'AZ', zip: '85001',
      consentCredit: true, consentCriminal: true,
    }

    afterEach(() => {
      vi.unstubAllGlobals()
      delete process.env.CHECKR_API_KEY
      delete process.env.CHECKR_PACKAGE
      delete process.env.CHECKR_WEBHOOK_SECRET
      delete process.env.CHECKR_BASE_URL
    })

    function stubFetch(handler: (url: string, init?: any) => Promise<Response>) {
      vi.stubGlobal('fetch', vi.fn(handler))
    }

    it('initiate: missing consent → failed (no fetch call)', async () => {
      process.env.CHECKR_API_KEY = 'k'
      const fetchCalls: string[] = []
      stubFetch(async (url) => { fetchCalls.push(url); return new Response('', { status: 200 }) })
      const provider = getProvider('checkr')
      const r = await provider.initiate({ ...sampleReq, consentCriminal: false })
      expect(r.status).toBe('failed')
      expect(fetchCalls).toEqual([])
    })

    it('initiate: no CHECKR_API_KEY → throws', async () => {
      const provider = getProvider('checkr')
      stubFetch(async () => new Response('', { status: 200 }))
      await expect(provider.initiate(sampleReq))
        .rejects.toThrow(/CHECKR_API_KEY is not set/)
    })

    it('initiate: candidate create non-2xx → failed result with reason', async () => {
      process.env.CHECKR_API_KEY = 'k'
      stubFetch(async () => new Response('bad request', { status: 400 }))
      const provider = getProvider('checkr')
      const r = await provider.initiate(sampleReq)
      expect(r.status).toBe('failed')
      expect(r.failureReason).toMatch(/candidate create failed: 400/)
    })

    it('initiate: candidate created but no CHECKR_PACKAGE → failed; providerRef = candidate id', async () => {
      process.env.CHECKR_API_KEY = 'k'
      stubFetch(async (url) => {
        if (url.endsWith('/candidates')) {
          return new Response(JSON.stringify({ id: 'cand_1' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response('', { status: 200 })
      })
      const provider = getProvider('checkr')
      const r = await provider.initiate(sampleReq)
      expect(r.status).toBe('failed')
      expect(r.providerRef).toBe('cand_1')
      expect(r.failureReason).toMatch(/CHECKR_PACKAGE env var not set/)
    })

    it('initiate: report create non-2xx → failed; providerRef = candidate id', async () => {
      process.env.CHECKR_API_KEY = 'k'
      process.env.CHECKR_PACKAGE = 'tasker_pro'
      stubFetch(async (url) => {
        if (url.endsWith('/candidates')) {
          return new Response(JSON.stringify({ id: 'cand_1' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response('upstream timeout', { status: 502 })
      })
      const provider = getProvider('checkr')
      const r = await provider.initiate(sampleReq)
      expect(r.status).toBe('failed')
      expect(r.providerRef).toBe('cand_1')
      expect(r.failureReason).toMatch(/report create failed: 502/)
    })

    it('initiate happy: providerRef = report.id; status mapped via mapCheckrStatus', async () => {
      process.env.CHECKR_API_KEY = 'k'
      process.env.CHECKR_PACKAGE = 'tasker_pro'
      stubFetch(async (url) => {
        if (url.endsWith('/candidates')) {
          return new Response(JSON.stringify({ id: 'cand_1' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({ id: 'rep_99', status: 'pending' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      })
      const provider = getProvider('checkr')
      const r = await provider.initiate(sampleReq)
      expect(r.providerRef).toBe('rep_99')
      expect(r.status).toBe('processing')  // pending → processing
    })

    it('verifyWebhook: no env secret → false (no dev convenience like mock)', () => {
      delete process.env.CHECKR_WEBHOOK_SECRET
      expect(getProvider('checkr').verifyWebhook({}, '{}')).toBe(false)
    })

    it('verifyWebhook: valid HMAC → true', () => {
      process.env.CHECKR_WEBHOOK_SECRET = 'sek'
      const body = '{"x":1}'
      const sig = crypto.createHmac('sha256', 'sek').update(body).digest('hex')
      expect(getProvider('checkr').verifyWebhook({ 'x-checkr-signature': sig }, body)).toBe(true)
    })

    it('verifyWebhook: bad signature → false', () => {
      process.env.CHECKR_WEBHOOK_SECRET = 'sek'
      const sig = crypto.createHmac('sha256', 'sek').update('other').digest('hex')
      expect(getProvider('checkr').verifyWebhook(
        { 'x-checkr-signature': sig }, '{"x":1}')).toBe(false)
    })

    it('parseWebhook happy: extracts data.object.id + status + adjudication into reportSummary', () => {
      const update = getProvider('checkr').parseWebhook(JSON.stringify({
        type: 'report.completed',
        data: { object: { id: 'rep_42', status: 'clear', adjudication: 'engaged' } },
      }))
      expect(update.providerRef).toBe('rep_42')
      expect(update.status).toBe('complete')  // 'clear' → 'complete'
      expect(update.reportSummary).toEqual({ adjudication: 'engaged', raw_status: 'clear' })
    })

    it('parseWebhook: consider → complete (adverse data but report is done)', () => {
      const update = getProvider('checkr').parseWebhook(JSON.stringify({
        data: { object: { id: 'rep_43', status: 'consider' } },
      }))
      expect(update.status).toBe('complete')
    })

    it('parseWebhook: missing data.object.id → throws', () => {
      expect(() => getProvider('checkr').parseWebhook(JSON.stringify({
        data: { object: {} },
      }))).toThrow(/missing data.object.id/)
    })

    it('craDisclosure returns Checkr Inc.', () => {
      expect(getProvider('checkr').craDisclosure().name).toBe('Checkr, Inc.')
    })
  })
})

// ═════════════════════════ subleaseDocuments ═════════════════════════

describe('subleaseDocuments', () => {
  const cleanupPaths: string[] = []
  afterAll(() => {
    for (const p of cleanupPaths) {
      try { fs.unlinkSync(p) } catch { /* best effort */ }
    }
  })

  interface SubleaseCtx {
    landlordId: string
    propertyId: string
    unitId: string
    masterLeaseId: string
    sublessorTenantId: string
    sublesseeTenantId: string
    subleaseId: string
  }

  async function seedSubleaseCtx(opts: { templateUrl?: string | null } = {}): Promise<SubleaseCtx> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId: landlordUserId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
      })
      if (opts.templateUrl !== undefined && opts.templateUrl !== null) {
        await c.query(`UPDATE properties SET sublease_agreement_template_url=$2 WHERE id=$1`,
          [propertyId, opts.templateUrl])
      }
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const sublessorTenantId = await seedTenant(c)
      const sublesseeTenantId = await seedTenant(c)
      const masterLeaseId = await seedLease(c, { unitId, landlordId, status: 'active' })
      await seedLeaseTenant(c, { leaseId: masterLeaseId, tenantId: sublessorTenantId, role: 'primary' })
      const { rows: [{ id: subleaseId }] } = await c.query<{ id: string }>(
        `INSERT INTO subleases
           (master_lease_id, sublessee_tenant_id, sublessor_tenant_id, status,
            start_date, sub_monthly_amount, master_share_amount)
         VALUES ($1, $2, $3, 'pending', '2026-01-01', 1200, 1000)
         RETURNING id`,
        [masterLeaseId, sublesseeTenantId, sublessorTenantId])
      await c.query('COMMIT')
      return {
        landlordId, propertyId, unitId, masterLeaseId,
        sublessorTenantId, sublesseeTenantId, subleaseId,
      }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  it('generateSubleaseDocument: sublease not found → 404', async () => {
    await expect(generateSubleaseDocument({
      subleaseId: '00000000-0000-0000-0000-000000000000',
    })).rejects.toThrow(/Sublease not found/)
  })

  it('generateSubleaseDocument: default PDF path — creates real on-disk PDF + 2 signers + fires signing email', async () => {
    const ctx = await seedSubleaseCtx()
    const res = await generateSubleaseDocument({ subleaseId: ctx.subleaseId })
    expect(res.documentId).toBeTruthy()
    expect(res.filename).toMatch(/^sublease-.*\.pdf$/)
    expect(res.fileUrl).toMatch(/^\/api\/esign\/files\/sublease-/)
    // File exists and parses as PDF.
    const filePath = `${process.cwd()}/uploads/subleases/${res.filename}`
    cleanupPaths.push(filePath)
    expect(fs.existsSync(filePath)).toBe(true)
    const bytes = fs.readFileSync(filePath)
    const parsed = await PDFDocument.load(bytes)
    expect(parsed.getPageCount()).toBeGreaterThanOrEqual(1)
    // Two signer rows + sublease linked to document.
    const { rows: signers } = await db.query<any>(
      `SELECT order_index, role FROM lease_document_signers WHERE document_id=$1
        ORDER BY order_index`, [res.documentId])
    expect(signers.map((s: any) => ({ idx: s.order_index, role: s.role })))
      .toEqual([{ idx: 1, role: 'tenant' }, { idx: 2, role: 'co_tenant' }])
    const { rows: [{ sublease_document_id }] } = await db.query<any>(
      `SELECT sublease_document_id FROM subleases WHERE id=$1`, [ctx.subleaseId])
    expect(sublease_document_id).toBe(res.documentId)
    // Signing email fired once for the first signer.
    expect(emailSigningRequestMock).toHaveBeenCalledTimes(1)
  })

  it('generateSubleaseDocument: template path — uses landlord URL, NO PDF generated', async () => {
    const ctx = await seedSubleaseCtx({
      templateUrl: 'https://landlord-cdn.example.com/sublease-template.pdf',
    })
    const res = await generateSubleaseDocument({ subleaseId: ctx.subleaseId })
    expect(res.fileUrl).toBe('https://landlord-cdn.example.com/sublease-template.pdf')
    expect(res.filename).toBe('sublease-template.pdf')
    // base_pdf_url on the document row points to the landlord template.
    const { rows: [{ base_pdf_url }] } = await db.query<any>(
      `SELECT base_pdf_url FROM lease_documents WHERE id=$1`, [res.documentId])
    expect(base_pdf_url).toBe('https://landlord-cdn.example.com/sublease-template.pdf')
  })

  it('generateSubleaseDocument: email failure swallowed (best-effort)', async () => {
    const ctx = await seedSubleaseCtx()
    emailSigningRequestMock.mockRejectedValueOnce(new Error('SMTP down'))
    const res = await generateSubleaseDocument({ subleaseId: ctx.subleaseId })
    cleanupPaths.push(`${process.cwd()}/uploads/subleases/${res.filename}`)
    expect(res.documentId).toBeTruthy()
    // Document still flips to 'sent' even though the email errored.
    const { rows: [{ status, sent_at }] } = await db.query<any>(
      `SELECT status, sent_at FROM lease_documents WHERE id=$1`, [res.documentId])
    expect(status).toBe('sent')
    expect(sent_at).not.toBeNull()
  })

  it('executeSubleaseAgreementCompletion: happy → sublease.status=active, sublease_document_url + landlord_consent_date stamped', async () => {
    const ctx = await seedSubleaseCtx()
    const gen = await generateSubleaseDocument({ subleaseId: ctx.subleaseId })
    cleanupPaths.push(`${process.cwd()}/uploads/subleases/${gen.filename}`)
    // Stamp executed_pdf_url on the document row (e-sign would do this).
    await db.query(
      `UPDATE lease_documents SET executed_pdf_url='https://gam.example/executed.pdf' WHERE id=$1`,
      [gen.documentId])
    const res = await executeSubleaseAgreementCompletion({ documentId: gen.documentId })
    expect(res.subleaseId).toBe(ctx.subleaseId)
    expect(res.status).toBe('active')
    const { rows: [s] } = await db.query<any>(
      `SELECT status, sublease_document_url, landlord_consent_date
         FROM subleases WHERE id=$1`, [ctx.subleaseId])
    expect(s.status).toBe('active')
    expect(s.sublease_document_url).toBe('https://gam.example/executed.pdf')
    expect(s.landlord_consent_date).not.toBeNull()
  })

  it('executeSubleaseAgreementCompletion: document not found → throws', async () => {
    await expect(executeSubleaseAgreementCompletion({
      documentId: '00000000-0000-0000-0000-000000000000',
    })).rejects.toThrow(/not found/)
  })

  it('executeSubleaseAgreementCompletion: orphan document (no sublease linked) → throws', async () => {
    // Seed a lease_documents row with no linked sublease.
    const c = await db.connect()
    let landlordId = '', unitId = ''
    try {
      await c.query('BEGIN')
      const { userId, landlordId: lid } = await seedLandlord(c)
      landlordId = lid
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: userId, managedByUserId: userId,
      })
      unitId = await seedUnit(c, { propertyId, landlordId })
      await c.query('COMMIT')
    } finally { c.release() }
    const { rows: [{ id: docId }] } = await db.query<{ id: string }>(
      `INSERT INTO lease_documents
         (landlord_id, unit_id, title, base_pdf_url, document_type, status)
       VALUES ($1, $2, 'Orphan', 'https://x', 'sublease_agreement', 'pending')
       RETURNING id`, [landlordId, unitId])
    await expect(executeSubleaseAgreementCompletion({ documentId: docId }))
      .rejects.toThrow(/Sublease for document/)
  })

  it('executeSubleaseAgreementCompletion: respects externalClient (caller owns release)', async () => {
    const ctx = await seedSubleaseCtx()
    const gen = await generateSubleaseDocument({ subleaseId: ctx.subleaseId })
    cleanupPaths.push(`${process.cwd()}/uploads/subleases/${gen.filename}`)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const res = await executeSubleaseAgreementCompletion(
        { documentId: gen.documentId }, client)
      expect(res.status).toBe('active')
      // Inside the transaction, the flip is visible to this client.
      const { rows: [s] } = await client.query<any>(
        `SELECT status FROM subleases WHERE id=$1`, [ctx.subleaseId])
      expect(s.status).toBe('active')
      // Rolling back undoes the flip — proves we ran on the passed client.
      await client.query('ROLLBACK')
    } finally { client.release() }
    const { rows: [post] } = await db.query<any>(
      `SELECT status FROM subleases WHERE id=$1`, [ctx.subleaseId])
    expect(post.status).toBe('pending')  // reverted by ROLLBACK
  })
})
