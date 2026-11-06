/**
 * ── THE PERSON WHO LOOKS AT THE PICTURE (Nic, 10/29) ───────────────────────
 *
 *   "Maybe we can have it where gam to-do list for gam admin people is
 *    verifying the front photo and typing it in by hand, or like letting the
 *    parser try to read the license and matching it up, and then we can flag a
 *    percentage of accuracy."
 *
 * The OCR has already said what it thinks and already graded itself against
 * the barcode where there was one (`licenceFrontOcr.ts`). What reaches this
 * queue is only what it could NOT settle: the two sides disagreeing, or a
 * state GAM has not read enough cards from to trust the front on its own.
 *
 * WHY THIS IS A GAM QUEUE AND NOT A LANDLORD ONE. An identification decides
 * which human being a debt belongs to, so letting the collecting landlord
 * confirm it would let the party with an interest in collecting decide whose
 * debt it is. GAM does it, same as the left-owing close calls.
 *
 * The person's answer is also the ANSWER KEY for a state with no barcode: a
 * hand-typed number is truth, so it grades that read and the per-state figure
 * climbs off real work instead of waiting on two-sided cards.
 */
import type { PoolClient } from 'pg'
import { query, queryOne, getClient } from '../db'
import { normalizedIdNumber } from '@gam/shared'
import { FRONT_OCR_MIN_SAMPLE, FRONT_OCR_TRUST_PCT } from './licenceFrontOcr'

/** One card waiting, with everything the person needs on the screen. */
export interface FrontReviewItem {
  identificationId: string
  /** Who it is attached to — a resident, or a single booking for a guest. */
  tenantId: string | null
  bookingId: string | null
  who: string | null
  idType: string
  /** What is on file now: typed by the guest, or read off the barcode. */
  idNumber: string
  issuingState: string | null
  dateOfBirth: string | null
  capturedHow: string
  reviewReason: string | null
  /** Both pictures, so the person can read the card themselves. */
  frontUrl: string | null
  backUrl: string | null
  /** What the OCR made of the front, and how sure it was. */
  readIdNumber: string | null
  readDateOfBirth: string | null
  readConfidence: number | null
  /** What the barcode said, where the back decoded. Null means no answer key. */
  truthIdNumber: string | null
  truthDateOfBirth: string | null
  /** How the front has done in this state so far. Null until it is a figure. */
  stateAccuracyPct: number | null
  stateAccuracySample: number | null
  waitingSince: string
}

export async function frontReviewQueue(limit = 200): Promise<FrontReviewItem[]> {
  const rows = await query<any>(
    `SELECT i.id, i.tenant_id, i.booking_id, i.id_type, i.id_number,
            i.issuing_state, to_char(i.date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
            i.captured_how, i.review_reason,
            i.document_front_url, i.document_url,
            to_char(i.updated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS waiting_since,
            COALESCE(
              NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''),
              b.guest_name) AS who,
            r.read_id_number, to_char(r.read_dob, 'YYYY-MM-DD') AS read_dob,
            r.ocr_confidence, r.truth_id_number, to_char(r.truth_dob, 'YYYY-MM-DD') AS truth_dob,
            -- The per-state figure, computed the same way the gate computes it,
            -- so the person sees the number that put this card in front of them.
            acc.n, acc.hit
       FROM tenant_identifications i
       LEFT JOIN tenants t ON t.id = i.tenant_id
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN unit_bookings b ON b.id = i.booking_id
       LEFT JOIN LATERAL (
              SELECT * FROM id_front_reads fr
               WHERE fr.identification_id = i.id
               ORDER BY fr.created_at DESC LIMIT 1) r ON true
       LEFT JOIN LATERAL (
              SELECT COUNT(*) AS n,
                     COUNT(*) FILTER (WHERE id_number_agreed AND dob_agreed) AS hit
                FROM id_front_reads fr2
               WHERE fr2.issuing_state = i.issuing_state
                 AND fr2.id_number_agreed IS NOT NULL) acc ON true
      WHERE i.needs_review = TRUE
      ORDER BY i.updated_at
      LIMIT $1`, [limit])

  return rows.map((r) => {
    const n = Number(r.n ?? 0)
    const enough = n >= FRONT_OCR_MIN_SAMPLE
    return {
      identificationId: r.id,
      tenantId: r.tenant_id, bookingId: r.booking_id, who: r.who ?? null,
      idType: r.id_type, idNumber: r.id_number,
      issuingState: r.issuing_state, dateOfBirth: r.date_of_birth,
      capturedHow: r.captured_how, reviewReason: r.review_reason,
      frontUrl: r.document_front_url ?? null, backUrl: r.document_url ?? null,
      readIdNumber: r.read_id_number ?? null, readDateOfBirth: r.read_dob ?? null,
      readConfidence: r.ocr_confidence === null ? null : Number(r.ocr_confidence),
      truthIdNumber: r.truth_id_number ?? null, truthDateOfBirth: r.truth_dob ?? null,
      stateAccuracyPct: enough ? Math.round((Number(r.hit) / n) * 1000) / 10 : null,
      stateAccuracySample: enough ? n : null,
      waitingSince: r.waiting_since,
    }
  })
}

/** How every state is doing, for the page that decides whether to trust any of it. */
export interface StateAccuracyRow {
  issuingState: string
  checked: number
  correctPct: number
  trusted: boolean
  /** Why not, in words, when it is not. */
  note: string
}

export async function frontAccuracyByState(): Promise<StateAccuracyRow[]> {
  const rows = await query<{ st: string; n: string; hit: string }>(
    `-- ── 10/29 (review): ONE CARD IS ONE SAMPLE, AND A MISSING DOB IS NOT A MISS ─
      --
      -- Two faults in one small sum, both of which corrupted the only figure
      -- that decides whether a person has to look.
      --
      -- 1. Every read was its own row with no dedupe, and the guest's page can
      --    be POSTed as often as they like against one booking. So one crisp
      --    card retaken ten times supplied half of Arizona's sample: twenty
      --    "checked" at 100% off two physical cards, and every later Arizona
      --    front skipped the queue. It worked downward too — one worn card
      --    retaken twenty times pushed a good state under the threshold and
      --    flooded the queue. Deduped to the LATEST read per identification,
      --    so a card counts once however many times it was photographed.
      --
      -- 2. The denominator asked for a graded NUMBER, but the numerator
      --    demanded the birthday agreed as well — and dob_agreed stays NULL
      --    whenever there was no birthday to grade against. A NULL is not a
      --    hit, so those reads could only ever count AGAINST the state. Twenty
      --    perfectly-read cards with no DOB on file reported "0% of 20", which
      --    guaranteed the hand work that is supposed to let a state earn its
      --    percentage could never do it. Now the birthday only counts when
      --    there was one to check: IS NOT FALSE, not AND.
      WITH one_per_card AS (
        SELECT DISTINCT ON (identification_id)
               identification_id, issuing_state, id_number_agreed, dob_agreed
          FROM id_front_reads
         WHERE id_number_agreed IS NOT NULL
         ORDER BY identification_id, created_at DESC, id DESC
      )
      SELECT COALESCE(issuing_state, '(not read)') AS st,
             COUNT(*)::text AS n,
             COUNT(*) FILTER (WHERE id_number_agreed AND dob_agreed IS NOT FALSE)::text AS hit
        FROM one_per_card
       GROUP BY 1 ORDER BY 2 DESC, 1`)
  return rows.map((r) => {
    const n = Number(r.n)
    const pct = Math.round((Number(r.hit) / n) * 1000) / 10
    const enough = n >= FRONT_OCR_MIN_SAMPLE
    const trusted = enough && pct >= FRONT_OCR_TRUST_PCT
    return {
      issuingState: r.st, checked: n, correctPct: pct, trusted,
      note: !enough
        ? `Only ${n} checked — a figure needs ${FRONT_OCR_MIN_SAMPLE} before it means anything.`
        : trusted
          ? `Read correctly ${pct}% of ${n}, so a front with no barcode goes through on its own.`
          : `Read correctly only ${pct}% of ${n}, so every front here is confirmed by hand.`,
    }
  })
}

export type FrontReviewDecision =
  | { decided: true; idNumber: string; dateOfBirth: string | null; gradedTheRead: boolean }
  | { decided: false; why: string }

/**
 * The answer. The person either confirms what is on file or types what the
 * card actually says; either way the card leaves the queue and their answer
 * becomes the truth the OCR is graded against.
 */
export async function decideFrontReview(args: {
  identificationId: string
  byUserId: string
  /** What the card says. Omitted means "what is on file is right." */
  idNumber?: string | null
  dateOfBirth?: string | null
  issuingState?: string | null
  note?: string | null
  client?: PoolClient
}): Promise<FrontReviewDecision> {
  const run = async (c: PoolClient): Promise<FrontReviewDecision> => {
    const cur = await c.query<{
      id: string; id_number: string; date_of_birth: string | null
      issuing_state: string | null; needs_review: boolean
    }>(
      `SELECT id, id_number, to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
              issuing_state, needs_review
         FROM tenant_identifications WHERE id = $1 FOR UPDATE`, [args.identificationId])
    const row = cur.rows[0]
    if (!row) return { decided: false, why: 'That identification is not on file.' }
    // Deciding twice is refused rather than overwritten — same as the
    // left-owing close calls. A second answer means two people disagreed and
    // that is worth seeing, not silently losing.
    if (!row.needs_review) {
      return { decided: false, why: 'Somebody has already confirmed this one.' }
    }

    const typed = normalizedIdNumber(args.idNumber)
    const idNumber = typed || row.id_number
    const dateOfBirth = args.dateOfBirth !== undefined
      ? (args.dateOfBirth || null) : row.date_of_birth
    const issuingState = args.issuingState !== undefined
      ? (args.issuingState ? args.issuingState.trim().toUpperCase() : null) : row.issuing_state

    await c.query(
      `UPDATE tenant_identifications
          SET id_number = $2, date_of_birth = $3::date, issuing_state = $4,
              needs_review = FALSE, review_reason = NULL,
              reviewed_at = NOW(), reviewed_by = $5,
              -- A person read this card, so it is verified in the sense that
              -- matters: somebody is accountable for the number on it.
              verified_at = COALESCE(verified_at, NOW()),
              verified_by = COALESCE(verified_by, $5),
              notes = CASE WHEN $6::text IS NULL THEN notes
                           ELSE TRIM(COALESCE(notes || E'\\n', '') || $6::text) END,
              updated_at = NOW()
        WHERE id = $1`,
      [args.identificationId, idNumber, dateOfBirth, issuingState, args.byUserId,
       args.note ?? null])

    /**
     * And the figure learns from it. A card with no barcode had no answer key,
     * which is exactly why it came here; a person typing the number IS the
     * answer key, so the read it came in with gets graded now. That is how a
     * state with no two-sided cards ever earns a percentage.
     */
    const ungraded = await c.query<{
      id: string; read_id_number: string | null; read_dob: string | null
    }>(
      `SELECT id, read_id_number, to_char(read_dob, 'YYYY-MM-DD') AS read_dob
         FROM id_front_reads
        WHERE identification_id = $1 AND id_number_agreed IS NULL
        FOR UPDATE`, [args.identificationId])

    for (const g of ungraded.rows) {
      // Normalizing happens in ONE place, the shared helper the scanner and
      // the typed form both run through — not in SQL, where a second spelling
      // of the same rule would drift from it.
      const agreed = normalizedIdNumber(g.read_id_number) === idNumber
      await c.query(
        `UPDATE id_front_reads
            SET truth_id_number = $2, truth_dob = COALESCE(truth_dob, $3::date),
                id_number_agreed = $4,
                dob_agreed = CASE WHEN $3::text IS NULL THEN dob_agreed
                                  ELSE ($3::text IS NOT DISTINCT FROM $5::text) END
          WHERE id = $1`,
        [g.id, idNumber, dateOfBirth, agreed, g.read_dob])
    }

    return {
      decided: true, idNumber, dateOfBirth,
      gradedTheRead: ungraded.rows.length > 0,
    }
  }

  if (args.client) return run(args.client)
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const out = await run(c)
    await c.query(out.decided ? 'COMMIT' : 'ROLLBACK')
    return out
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

/** How many are waiting, for the admin to-do count. */
export async function frontReviewCount(): Promise<number> {
  const r = await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM tenant_identifications WHERE needs_review = TRUE`)
  return Number(r?.n ?? 0)
}
