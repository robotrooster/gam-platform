/**
 * The contractor marketplace — 10/31, Nic's dictated vision.
 *
 * "I want to compete with Angie's List because Angie's List has gone downhill.
 *  The way I see it is contractors can make a profile. And when landlords put a
 *  job out that's open for a bid, contractors have to go on there and bid the
 *  job. It's like searching a marketplace, like searching eBay... you're
 *  browsing the marketplace for open jobs. You bid. They're all private to the
 *  person so that people aren't just publicly underbidding other people. It
 *  helps keep it fair. Contractors are on the platform for free. GAM takes a
 *  cut of the finished job... Angie's List charges people for leads. We don't
 *  want to charge that. We want to charge off of the completed job."
 *
 * This is NOT the business portal, and the two must not be merged later. In his
 * words the same day: "The business portal is for somebody operating their
 * small business. A landscaper trying to get more yards is going to post his
 * prices, run his customers and invoicing through there. That is subscription
 * based. Contractors that are looking for one-off jobs on bids, that's a
 * percentage of the cut. A cut of the job. It's two different things."
 *
 * Four things in here are load-bearing:
 *
 * 1. A BID IS PRIVATE. Every read of a bid is scoped to the landlord who owns
 *    the job or the contractor who made it. There is no count, no "lowest so
 *    far", no spread exposed to any contractor — any of those leak straight
 *    back to the bidders and turn the board into the race to the bottom Nic is
 *    competing against.
 *
 * 2. NOTHING IS EARNED UNTIL THE WORK IS FINISHED. No listing fee, no lead fee,
 *    no fee on a bid, no fee on an award. The only money event is a completed
 *    job.
 *
 * 3. THE RATE IS SNAPSHOTTED AT AWARD. That is the deal the contractor
 *    accepted; a later re-price never reaches back into work already won. But
 *    the AMOUNT is what the job actually finished at, because scope moves.
 *
 * 4. SCOPE RUNS THROUGH THE PROPERTY. A landlord session names no single
 *    `landlords` row (an account is not an entity, and one account may own
 *    several), and a worker may be narrowed to some of a company's properties.
 *    So every landlord-side read takes a LandlordScope, never one id.
 */
import type { PoolClient } from 'pg'
import {
  MARKETPLACE_JOB_STATUSES,
  marketplaceCutSplit,
  type ContractorTrade,
  type MarketplaceJobStatus,
} from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { recordPlatformRevenue } from './platformRevenue'

import { dateIn } from '../lib/timezone'
// ── The price card ────────────────────────────────────────────

/**
 * GAM's cut for a job awarded on `on`, as a percent.
 *
 * Throws when no card covers the date. Deliberate, and the same discipline as
 * services/flexFees.ts: a quote with no row is an error, never a zero, so a
 * forgotten price card can never silently make the marketplace free.
 */
export async function requireMarketplaceCutPercent(on: Date | string = new Date()): Promise<number> {
  // GAM'S CALENDAR, NOT UTC. toISOString() is already tomorrow after 5pm
  // Phoenix, so a card dated "from tomorrow" was in force this evening — a
  // re-price reaching back into a plan being priced right now. Caught by the
  // financing suite's own re-price test.
  const day = typeof on === 'string' ? on : dateIn(null, on)
  const row = await queryOne<{ percent: string }>(
    `SELECT percent::text AS percent
       FROM marketplace_cut_rates
      WHERE effective_from <= $1::date
      ORDER BY effective_from DESC
      LIMIT 1`,
    [day])
  if (!row) {
    throw new AppError(500,
      'GAM has no marketplace rate on file for that date, so this job cannot be settled yet. Nothing was charged.')
  }
  const pct = Number(row.percent)
  if (!Number.isFinite(pct) || pct < 0) {
    throw new AppError(500,
      'The marketplace rate on file is not a usable number, so this job cannot be settled yet. Nothing was charged.')
  }
  return pct
}

/**
 * What GAM keeps on a job that finished at `finalAmount`, rounded to the cent.
 *
 * Delegates to the shared split so the figure booked here is the same figure
 * both screens showed before anyone committed — the landlord's settle step and
 * the contractor's bid form read the same function.
 */
export function marketplaceCutAmount(finalAmount: number, cutPercent: number): number {
  return marketplaceCutSplit(finalAmount, cutPercent).cut
}

// ── Scope ─────────────────────────────────────────────────────

/**
 * Which landlord entities and which properties a caller may act for.
 *
 * `propertyIds === null` means "not narrowed to particular properties" (an
 * owner). That is NOT the same as `[]`, which is a caller scoped to no property
 * at all and must match nothing.
 */
export interface LandlordScope {
  landlordIds: string[]
  propertyIds: string[] | null
}

/** The WHERE fragment that keeps a caller inside their own parks. */
function scopeSql(scope: LandlordScope, params: unknown[]): string {
  let sql = `j.landlord_id = ANY($${params.push(scope.landlordIds)}::uuid[])`
  if (scope.propertyIds !== null) {
    sql += ` AND j.property_id = ANY($${params.push(scope.propertyIds)}::uuid[])`
  }
  return sql
}

// ── Shapes ────────────────────────────────────────────────────

export interface MarketplaceJobRow {
  id: string
  landlord_id: string
  property_id: string
  property_name: string | null
  unit_id: string | null
  maintenance_request_id: string | null
  title: string
  description: string
  trades: string[]
  photos: string[]
  requires_insured: boolean
  requires_bonded: boolean
  status: MarketplaceJobStatus
  bids_close_at: string | null
  awarded_bid_id: string | null
  awarded_contractor_id: string | null
  awarded_amount: string | null
  awarded_at: string | null
  final_amount: string | null
  completed_at: string | null
  cut_percent_snapshot: string | null
  cancelled_at: string | null
  cancelled_reason: string | null
  created_at: string
}

/**
 * WHAT A CONTRACTOR SEES ON THE OPEN BOARD — 10/31 (Nic).
 *
 * "I think we should reveal location, like city location of the job. That way a
 *  contractor knows they're bidding on, like, hey, fixing blah, blah, blah
 *  amount of things in that city, so they can plan commute time, getting
 *  material delivered, whatever. But I don't think it should show the exact
 *  property address or say exactly who the landlord is. Have that be possibly
 *  anonymous."
 *
 * So: CITY AND STATE, and nothing that names the place or the person. No
 * landlord id, no property id or name, no unit, no street. A park's name is as
 * identifying as its address — "Oak Park, Mesa AZ" is one search away from the
 * front gate — so the name is withheld with the address, not treated as safe
 * because it is not a street.
 *
 * He also said, of blocking in general: "the more you try to block, the more
 * people are going to just try to cheat it anyway." This is not an attempt to
 * make the park unguessable. It is about not handing out the owner's name and
 * door number to everyone who browses, while still giving a contractor the one
 * fact they need to price the drive and the delivery.
 *
 * The full address IS given the moment they WIN the job — they have to get
 * there. See listAwardedJobsForContractor.
 */
const BOARD_SELECT = `
  j.id, j.title, j.description, j.trades, j.photos,
  j.requires_insured, j.requires_bonded, j.status, j.bids_close_at, j.created_at,
  p.city AS property_city, p.state AS property_state`

/** A job this contractor WON: now they need to know where to go. */
const AWARDED_SELECT = `
  j.id, j.title, j.description, j.trades, j.photos,
  j.requires_insured, j.requires_bonded, j.status, j.created_at,
  j.awarded_amount, j.awarded_at, j.final_amount, j.completed_at,
  p.name AS property_name, p.street1 AS property_street1, p.street2 AS property_street2,
  p.city AS property_city, p.state AS property_state, p.zip AS property_zip,
  u.unit_number AS unit_number`

const JOB_SELECT = `
  j.id, j.landlord_id, j.property_id, p.name AS property_name, j.unit_id,
  j.maintenance_request_id, j.title, j.description, j.trades, j.photos,
  j.requires_insured, j.requires_bonded, j.status, j.bids_close_at,
  j.awarded_bid_id, j.awarded_contractor_id, j.awarded_amount, j.awarded_at,
  j.final_amount, j.completed_at, j.cut_percent_snapshot,
  j.cancelled_at, j.cancelled_reason, j.created_at`

// ── The landlord's side ───────────────────────────────────────

/**
 * Post a job out for bids.
 *
 * The landlord entity is read OFF THE PROPERTY rather than taken from the
 * caller, because ownership lives on the property. The route has already
 * checked the caller may act on that property.
 */
export async function postJob(args: {
  scope: LandlordScope
  propertyId: string
  unitId?: string | null
  maintenanceRequestId?: string | null
  title: string
  description: string
  trades: ContractorTrade[]
  photos?: string[]
  requiresInsured: boolean
  requiresBonded: boolean
  bidsCloseAt?: string | null
  createdByUserId: string
}): Promise<MarketplaceJobRow> {
  const prop = await queryOne<{ id: string; landlord_id: string }>(
    `SELECT id, landlord_id FROM properties WHERE id = $1`, [args.propertyId])
  if (!prop) throw new AppError(404, 'That property does not exist.')
  if (!prop.landlord_id) {
    throw new AppError(409,
      'That property is not attached to a company yet, so a job cannot be posted for it.')
  }

  // THE COMPANY GATE, AND IT HAS TO BE HERE.
  //
  // assertPropertyInScope does NOT refuse a landlord who is a stranger to the
  // property's company — its own comment says so: "Not a member at all falls
  // through to the bypass... this function has never been the thing that did
  // it." It asks the narrower question of a MANAGER's grant. So without the
  // line below, any landlord could post a job against any other landlord's
  // property, and the job would then be stamped with that other company's id.
  // Caught by this file's own cross-company test, which returned 201.
  //
  // Checked in the service rather than the route so it holds however this is
  // reached later.
  if (!args.scope.landlordIds.includes(prop.landlord_id)) {
    throw new AppError(404, 'That property is not one of yours.')
  }
  if (args.scope.propertyIds !== null && !args.scope.propertyIds.includes(args.propertyId)) {
    throw new AppError(403, 'You are not assigned to this property.')
  }

  if (args.unitId) {
    // Unit numbers repeat across parks, so a unit is only ever resolved WITHIN
    // its property.
    const unit = await queryOne<{ id: string }>(
      `SELECT id FROM units WHERE id = $1 AND property_id = $2`,
      [args.unitId, args.propertyId])
    if (!unit) throw new AppError(404, 'That space is not at that property.')
  }

  const row = await queryOne<{ id: string }>(
    `INSERT INTO marketplace_jobs
       (landlord_id, property_id, unit_id, maintenance_request_id, title, description,
        trades, photos, requires_insured, requires_bonded, bids_close_at, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [prop.landlord_id, args.propertyId, args.unitId ?? null, args.maintenanceRequestId ?? null,
     args.title, args.description, args.trades, args.photos ?? [],
     args.requiresInsured, args.requiresBonded, args.bidsCloseAt ?? null, args.createdByUserId])

  return (await getJobInScope(String(row!.id), args.scope))!
}

export async function getJobInScope(jobId: string, scope: LandlordScope): Promise<MarketplaceJobRow | null> {
  if (scope.landlordIds.length === 0) return null
  const params: unknown[] = [jobId]
  const where = scopeSql(scope, params)
  return await queryOne<MarketplaceJobRow>(
    `SELECT ${JOB_SELECT}
       FROM marketplace_jobs j
       JOIN properties p ON p.id = j.property_id
      WHERE j.id = $1 AND ${where}`,
    params)
}

export async function listJobsInScope(scope: LandlordScope, opts: { status?: MarketplaceJobStatus } = {}) {
  if (scope.landlordIds.length === 0) return []
  const params: unknown[] = []
  const where = scopeSql(scope, params)
  const statusIdx = params.push(opts.status ?? null)
  return await query(
    `SELECT ${JOB_SELECT},
            (SELECT COUNT(*) FROM marketplace_bids b
              WHERE b.job_id = j.id AND b.status IN ('submitted','accepted'))::text AS bid_count
       FROM marketplace_jobs j
       JOIN properties p ON p.id = j.property_id
      WHERE ${where} AND ($${statusIdx}::text IS NULL OR j.status = $${statusIdx})
      ORDER BY j.created_at DESC`,
    params)
}

/**
 * The bids on a job, for the landlord who posted it.
 *
 * The ONLY place bid numbers are returned. The landlord sees every bid on their
 * own job because they are choosing and need the field. No contractor reaches
 * this at all, and there is no cross-job aggregate anywhere.
 */
export async function listBidsInScope(jobId: string, scope: LandlordScope) {
  const job = await getJobInScope(jobId, scope)
  if (!job) throw new AppError(404, 'That job is not one of yours.')
  return await query(
    `SELECT b.id, b.job_id, b.contractor_id, b.amount, b.notes, b.days_to_complete,
            b.insured_at_bid, b.bonded_at_bid, b.status, b.created_at,
            c.name AS contractor_name, c.business_name AS contractor_business_name,
            c.rating AS contractor_rating, c.completed_jobs AS contractor_completed_jobs,
            c.insurance_verified, c.insurance_expiry, c.bond_verified, c.bond_expiry
       FROM marketplace_bids b
       JOIN contractors c ON c.id = b.contractor_id
      WHERE b.job_id = $1 AND b.status <> 'withdrawn'
      ORDER BY b.amount ASC, b.created_at ASC`,
    [jobId])
}

/**
 * Award the job to one bid.
 *
 * Snapshots the cut rate here, because this is the moment the contractor
 * accepts the deal. Every other live bid is declined in the same transaction,
 * so nobody is left waiting on a job that is already gone.
 */
export async function awardBid(args: {
  jobId: string
  bidId: string
  scope: LandlordScope
}): Promise<MarketplaceJobRow> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const params: unknown[] = [args.jobId]
    const where = scopeSql(args.scope, params)
    const job = await one<{ id: string; status: string }>(client,
      `SELECT j.id, j.status FROM marketplace_jobs j
        WHERE j.id = $1 AND ${where} FOR UPDATE`, params)
    if (!job) throw new AppError(404, 'That job is not one of yours.')
    if (job.status !== 'open') {
      throw new AppError(409,
        'This job is no longer taking bids, so it cannot be awarded again. Nothing was changed.')
    }
    const bid = await one<{ id: string; contractor_id: string; amount: string }>(client,
      `SELECT id, contractor_id, amount::text AS amount
         FROM marketplace_bids
        WHERE id = $1 AND job_id = $2 AND status = 'submitted'`,
      [args.bidId, args.jobId])
    if (!bid) {
      throw new AppError(404,
        'That bid is not on this job any more — the contractor may have withdrawn it. Nothing was changed.')
    }

    const cutPercent = await requireMarketplaceCutPercent()

    await client.query(
      `UPDATE marketplace_bids SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
        WHERE id = $1`, [bid.id])
    await client.query(
      `UPDATE marketplace_bids
          SET status = 'declined', declined_at = NOW(), updated_at = NOW()
        WHERE job_id = $1 AND id <> $2 AND status = 'submitted'`,
      [args.jobId, bid.id])
    await client.query(
      `UPDATE marketplace_jobs
          SET status = 'awarded', awarded_bid_id = $2, awarded_contractor_id = $3,
              awarded_amount = $4, awarded_at = NOW(), cut_percent_snapshot = $5,
              updated_at = NOW()
        WHERE id = $1`,
      [args.jobId, bid.id, bid.contractor_id, Number(bid.amount), cutPercent])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
  return (await getJobInScope(args.jobId, args.scope))!
}

/**
 * Mark the job finished, and book GAM's cut.
 *
 * The cut comes off what the job ACTUALLY finished at — a $4,000 bid settled at
 * $4,600 earns GAM 3% of $4,600 — at the RATE snapshotted when it was awarded.
 *
 * Booking is idempotent per (type, reference) inside recordPlatformRevenue, and
 * the status guard refuses a second attempt as well. Both doors are shut on
 * purpose, because this one writes money.
 */
export async function completeJob(args: {
  jobId: string
  scope: LandlordScope
  finalAmount?: number | null
}): Promise<{ job: MarketplaceJobRow; cutAmount: number; contractorNet: number }> {
  const client = await getClient()
  let cutAmount = 0
  let finalAmount = 0
  let cutPct = 0
  try {
    await client.query('BEGIN')
    const params: unknown[] = [args.jobId]
    const where = scopeSql(args.scope, params)
    const job = await one<{
      id: string; status: string; property_id: string
      awarded_amount: string | null; cut_percent_snapshot: string | null
      awarded_contractor_id: string | null
    }>(client,
      `SELECT j.id, j.status, j.property_id, j.awarded_amount::text AS awarded_amount,
              j.cut_percent_snapshot::text AS cut_percent_snapshot, j.awarded_contractor_id
         FROM marketplace_jobs j
        WHERE j.id = $1 AND ${where} FOR UPDATE`, params)
    if (!job) throw new AppError(404, 'That job is not one of yours.')
    if (job.status === 'completed') {
      throw new AppError(409, 'This job is already marked finished. Nothing was changed.')
    }
    if (job.status !== 'awarded' && job.status !== 'in_progress') {
      throw new AppError(409,
        'This job has not been awarded to anyone yet, so there is nothing to finish. Nothing was changed.')
    }
    if (job.cut_percent_snapshot == null || job.awarded_amount == null) {
      throw new AppError(409,
        'This job is missing the rate it was awarded under, so it cannot be settled. Nothing was changed.')
    }

    finalAmount = args.finalAmount == null ? Number(job.awarded_amount) : args.finalAmount
    if (!Number.isFinite(finalAmount) || finalAmount < 0) {
      throw new AppError(400, 'The amount the job finished at has to be a number, and cannot be negative.')
    }
    cutPct = Number(job.cut_percent_snapshot)
    cutAmount = marketplaceCutAmount(finalAmount, cutPct)

    await client.query(
      `UPDATE marketplace_jobs
          SET status = 'completed', completed_at = NOW(), final_amount = $2, updated_at = NOW()
        WHERE id = $1`,
      [args.jobId, finalAmount])
    // Their count of finished work — the only thing a contractor earns from the
    // marketplace besides the money.
    if (job.awarded_contractor_id) {
      await client.query(
        `UPDATE contractors SET completed_jobs = COALESCE(completed_jobs, 0) + 1, updated_at = NOW()
          WHERE id = $1`, [job.awarded_contractor_id])
    }

    if (cutAmount > 0) {
      await recordPlatformRevenue({
        type: 'marketplace_job_cut',
        amount: cutAmount,
        referenceId: args.jobId,
        referenceType: 'marketplace_job',
        propertyId: job.property_id,
        notes: `${Number(job.cut_percent_snapshot)}% of a finished marketplace job of $${finalAmount.toFixed(2)}`,
      }, client)
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
  const job = (await getJobInScope(args.jobId, args.scope))!
  return { job, cutAmount, contractorNet: marketplaceCutSplit(finalAmount, cutPct).contractorNet }
}

export async function cancelJob(args: {
  jobId: string; scope: LandlordScope; reason?: string | null
}): Promise<MarketplaceJobRow> {
  const params: unknown[] = [args.jobId]
  const where = scopeSql(args.scope, params)
  const reasonIdx = params.push(args.reason ?? null)
  const done = await query<{ id: string }>(
    `UPDATE marketplace_jobs AS j
        SET status = 'cancelled', cancelled_at = NOW(), cancelled_reason = $${reasonIdx},
            updated_at = NOW()
      WHERE j.id = $1 AND ${where} AND j.status IN ('open', 'awarded')
      RETURNING j.id`,
    params)
  if (done.length === 0) {
    const exists = await getJobInScope(args.jobId, args.scope)
    if (!exists) throw new AppError(404, 'That job is not one of yours.')
    throw new AppError(409,
      'Work has already started or finished on this job, so it cannot be cancelled. Nothing was changed.')
  }
  // Nobody is left holding a live bid on a job that is gone.
  await query(
    `UPDATE marketplace_bids SET status = 'declined', declined_at = NOW(), updated_at = NOW()
      WHERE job_id = $1 AND status = 'submitted'`, [args.jobId])
  return (await getJobInScope(args.jobId, args.scope))!
}

// ── The contractor's side ─────────────────────────────────────

export interface ContractorRow {
  id: string
  status: string
  trades: string[] | null
  insurance_verified: boolean
  insurance_expiry: string | null
  bond_verified: boolean
  bond_expiry: string | null
  suspended_at: string | null
  /** Where they are, which is what decides the price of a top spot near them. */
  city: string | null
  state: string | null
}

/** The contractor profile behind a login, or null if they have none. */
export async function contractorForUser(userId: string): Promise<ContractorRow | null> {
  return await queryOne<ContractorRow>(
    `SELECT id, status, trades, insurance_verified, insurance_expiry,
            bond_verified, bond_expiry, suspended_at, city, state
       FROM contractors WHERE user_id = $1`,
    [userId])
}

/** Insurance and bond that are on file AND not expired, as of today. */
export function credentialsInForce(c: {
  insurance_verified: boolean; insurance_expiry: string | Date | null
  bond_verified: boolean; bond_expiry: string | Date | null
}, today = new Date()): { insured: boolean; bonded: boolean } {
  const day = isoDay(today)
  const live = (verified: boolean, expiry: string | Date | null) =>
    verified && (expiry == null || isoDay(expiry) >= day)
  return {
    insured: live(c.insurance_verified, c.insurance_expiry),
    bonded: live(c.bond_verified, c.bond_expiry),
  }
}

/**
 * A date column as a comparable YYYY-MM-DD.
 *
 * pg hands a `date` column back as a JS Date, not a string, and
 * `String(someDate).slice(0, 10)` yields "Fri Oct 30" — which compares
 * alphabetically against "2026-10-31" and says an expired policy is still
 * live. That is a real failure mode for the insured gate, caught by this
 * file's own expiry test, so the conversion is explicit and shared.
 */
function isoDay(v: string | Date): string {
  if (v instanceof Date) {
    // Local parts, not toISOString(): a date column has no time zone, and
    // converting to UTC can move it a day for anyone behind Greenwich.
    const m = String(v.getMonth() + 1).padStart(2, '0')
    const d = String(v.getDate()).padStart(2, '0')
    return `${v.getFullYear()}-${m}-${d}`
  }
  return String(v).slice(0, 10)
}

/**
 * The open board, as one contractor sees it.
 *
 * Carries NO bid information whatsoever — not other contractors' numbers, not a
 * count, not a range — except whether THIS contractor has already bid, which is
 * their own fact. That omission is the product, not an oversight.
 *
 * A job whose requirement this contractor does not meet is still SHOWN, with
 * the requirement named, so they know what paperwork would open it up. Hiding
 * it would just look like an empty board.
 */
export async function browseOpenJobs(args: {
  contractorId: string
  trades?: ContractorTrade[] | null
  state?: string | null
  search?: string | null
  limit?: number
}) {
  return await query(
    `SELECT ${BOARD_SELECT},
            EXISTS (SELECT 1 FROM marketplace_bids b
                     WHERE b.job_id = j.id AND b.contractor_id = $1
                       AND b.status IN ('submitted','accepted')) AS already_bid
       FROM marketplace_jobs j
       JOIN properties p ON p.id = j.property_id
      WHERE j.status = 'open'
        AND (j.bids_close_at IS NULL OR j.bids_close_at > NOW())
        AND ($2::text[] IS NULL OR j.trades && $2::text[])
        AND ($3::text IS NULL OR p.state = $3)
        AND ($4::text IS NULL OR j.title ILIKE '%' || $4 || '%' OR j.description ILIKE '%' || $4 || '%')
      ORDER BY j.created_at DESC
      LIMIT $5`,
    [args.contractorId,
     args.trades && args.trades.length ? args.trades : null,
     args.state ?? null, args.search ?? null, args.limit ?? 100])
}

/**
 * One job as a contractor sees it.
 *
 * Anonymous while it is open — city and state only — and the full address the
 * moment this contractor is the one who won it. The two shapes are two
 * different SELECTs rather than one with fields blanked out, so there is no
 * single query that could accidentally return the address to a browser.
 */
export async function getOpenJobForContractor(jobId: string, contractorId: string) {
  const won = await queryOne(
    `SELECT ${AWARDED_SELECT},
            TRUE AS already_bid, TRUE AS mine
       FROM marketplace_jobs j
       JOIN properties p ON p.id = j.property_id
       LEFT JOIN units u ON u.id = j.unit_id
      WHERE j.id = $1 AND j.awarded_contractor_id = $2`,
    [jobId, contractorId])
  if (won) return won
  return await queryOne(
    `SELECT ${BOARD_SELECT},
            EXISTS (SELECT 1 FROM marketplace_bids b
                     WHERE b.job_id = j.id AND b.contractor_id = $2
                       AND b.status IN ('submitted','accepted')) AS already_bid,
            FALSE AS mine
       FROM marketplace_jobs j
       JOIN properties p ON p.id = j.property_id
      WHERE j.id = $1 AND j.status = 'open'`,
    [jobId, contractorId])
}

export interface MarketplaceBidRow {
  id: string
  job_id: string
  contractor_id: string
  amount: string
  notes: string | null
  days_to_complete: number | null
  insured_at_bid: boolean
  bonded_at_bid: boolean
  status: string
  created_at: string
}

/**
 * Place a bid.
 *
 * Records whether this contractor held insurance and a bond at this moment, so
 * the landlord reading the bid later sees what was true when they chose.
 *
 * A contractor who does not meet the job's stated requirement may STILL bid.
 * The landlord side was told to warn loudly and send anyway if they insist
 * (Nic, 10/31 — GAM does not referee how a landlord runs their property), so
 * the mirror of that is that GAM does not refuse the bid either. The landlord
 * sees the gap named on the bid.
 */
export async function placeBid(args: {
  jobId: string
  contractorId: string
  amount: number
  notes?: string | null
  daysToComplete?: number | null
  createdByUserId: string
}): Promise<MarketplaceBidRow> {
  const c = await queryOne<ContractorRow>(
    `SELECT id, status, trades, insurance_verified, insurance_expiry,
            bond_verified, bond_expiry, suspended_at
       FROM contractors WHERE id = $1`, [args.contractorId])
  if (!c) throw new AppError(404, 'That contractor profile does not exist.')
  if (c.status !== 'active') {
    throw new AppError(403, 'This profile is not taking work right now, so no bid was placed.')
  }

  const job = await queryOne<{ id: string; status: string; bids_close_at: string | null }>(
    `SELECT id, status, bids_close_at FROM marketplace_jobs WHERE id = $1`, [args.jobId])
  if (!job) throw new AppError(404, 'That job does not exist.')
  if (job.status !== 'open') {
    throw new AppError(409, 'This job has stopped taking bids. Nothing was sent.')
  }
  if (job.bids_close_at && new Date(job.bids_close_at) <= new Date()) {
    throw new AppError(409, 'Bidding on this job has closed. Nothing was sent.')
  }
  if (!Number.isFinite(args.amount) || args.amount < 0) {
    throw new AppError(400, 'A bid has to be an amount, and it cannot be negative.')
  }

  const inForce = credentialsInForce(c)
  try {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO marketplace_bids
         (job_id, contractor_id, amount, notes, days_to_complete,
          insured_at_bid, bonded_at_bid, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [args.jobId, args.contractorId, args.amount, args.notes ?? null,
       args.daysToComplete ?? null, inForce.insured, inForce.bonded, args.createdByUserId])
    return (await getBidForContractor(String(row!.id), args.contractorId))!
  } catch (err) {
    // 23505 = unique_violation: the one-live-bid-per-contractor index.
    if (String((err as { code?: string }).code) === '23505') {
      throw new AppError(409,
        'You already have a bid in on this job. Withdraw it first if you want to change your number.')
    }
    throw err
  }
}

export async function getBidForContractor(bidId: string, contractorId: string) {
  return await queryOne<MarketplaceBidRow>(
    `SELECT id, job_id, contractor_id, amount, notes, days_to_complete,
            insured_at_bid, bonded_at_bid, status, created_at
       FROM marketplace_bids WHERE id = $1 AND contractor_id = $2`,
    [bidId, contractorId])
}

export async function withdrawBid(args: { bidId: string; contractorId: string }): Promise<void> {
  const done = await query<{ id: string }>(
    `UPDATE marketplace_bids
        SET status = 'withdrawn', withdrawn_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND contractor_id = $2 AND status = 'submitted'
      RETURNING id`,
    [args.bidId, args.contractorId])
  if (done.length === 0) {
    const bid = await getBidForContractor(args.bidId, args.contractorId)
    if (!bid) throw new AppError(404, 'That bid is not yours.')
    if (bid.status === 'accepted') {
      throw new AppError(409,
        'You won this job, so the bid cannot be withdrawn. Talk to the landlord if you need out of it.')
    }
    throw new AppError(409, 'That bid is no longer live, so there is nothing to withdraw.')
  }
}

/** A contractor's own bids, with the job they are on. Theirs only. */
export async function listBidsForContractor(contractorId: string) {
  return await query(
    `SELECT b.id, b.job_id, b.amount, b.notes, b.days_to_complete, b.status,
            b.created_at, b.insured_at_bid, b.bonded_at_bid,
            j.title, j.status AS job_status, j.requires_insured, j.requires_bonded,
            j.final_amount, j.completed_at,
            p.city AS property_city, p.state AS property_state
       FROM marketplace_bids b
       JOIN marketplace_jobs j ON j.id = b.job_id
       JOIN properties p ON p.id = j.property_id
      WHERE b.contractor_id = $1
      ORDER BY b.created_at DESC`,
    [contractorId])
}

/**
 * Jobs this contractor actually won.
 *
 * The full address and the space number, because they have to turn up. The
 * anonymity on the open board is about not handing the owner's door number to
 * everyone browsing; the person doing the work plainly needs it.
 */
export async function listAwardedJobsForContractor(contractorId: string) {
  return await query(
    `SELECT ${AWARDED_SELECT}
       FROM marketplace_jobs j
       JOIN properties p ON p.id = j.property_id
       LEFT JOIN units u ON u.id = j.unit_id
      WHERE j.awarded_contractor_id = $1
      ORDER BY j.awarded_at DESC NULLS LAST`,
    [contractorId])
}

/** The contractor says they have started. The landlord still owns "finished". */
export async function startWork(args: { jobId: string; contractorId: string }): Promise<void> {
  const done = await query<{ id: string }>(
    `UPDATE marketplace_jobs
        SET status = 'in_progress', updated_at = NOW()
      WHERE id = $1 AND awarded_contractor_id = $2 AND status = 'awarded'
      RETURNING id`,
    [args.jobId, args.contractorId])
  if (done.length === 0) {
    throw new AppError(409,
      'This job is not sitting awarded to you, so there is nothing to start. Nothing was changed.')
  }
}

// ── small helpers ─────────────────────────────────────────────

async function one<T>(client: PoolClient, sql: string, params: unknown[]): Promise<T | null> {
  const r = await client.query(sql, params)
  return (r.rows[0] as T) ?? null
}

/** Guard used by the route layer and by tests: is this a real job status? */
export function isMarketplaceJobStatus(v: unknown): v is MarketplaceJobStatus {
  return typeof v === 'string' && (MARKETPLACE_JOB_STATUSES as readonly string[]).includes(v)
}
