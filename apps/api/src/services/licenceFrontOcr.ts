/**
 * ── READING THE FRONT, AND KNOWING WHEN NOT TO TRUST IT (Nic, 10/29) ────────
 *
 *   "Let's do local OCR, I guess, but let's have a human verification for
 *    things that are either potentially wrong or knowingly need to be looked
 *    at... we can flag a percentage of accuracy of, hey, we're getting 99%
 *    accuracy in this state, and this state is only 30%."
 *
 * The engine runs HERE, on GAM's own machine — no picture of anybody's licence
 * is sent to Google or Amazon to be read, which is the one category of data
 * where that would be hardest to defend.
 *
 * THE BARCODE IS THE ANSWER KEY. Where the guest sent both sides, the back
 * decodes exactly, so it says what the front should have said. Every front
 * read grades itself against it, on real cards from real states, at no cost —
 * which is what turns "how accurate is the OCR in Arizona" from a guess into a
 * measurement.
 *
 * WHAT IT IS FOR, AND WHAT IT IS NOT. Even reading cleanly it is a PRE-FILL
 * and a cross-check, never the source of truth. A licence front is printed
 * over a hologram in a layout that differs by state, and a worked example from
 * building this: a test card that read perfectly dropped the licence number
 * entirely when that one line was set in a larger font. That is the fragility
 * the per-state figure exists to measure.
 */
import type { PoolClient } from 'pg'
import path from 'path'
import { logger } from '../lib/logger'
import { normalizedIdNumber, isRealDay } from '@gam/shared'

/** Below this, a state's reads are not trusted without a person looking. */
export const FRONT_OCR_TRUST_PCT = 90
/** And a figure from too few cards is not a figure yet. */
export const FRONT_OCR_MIN_SAMPLE = 20

export interface FrontRead {
  idNumber?: string
  dateOfBirth?: string
  expiryDate?: string
  issuingState?: string
  /** Tesseract's own mean confidence, 0-100. Its opinion, not a verdict. */
  confidence: number
  /** Everything it saw, kept so a person checking has the same view. */
  text: string
}

/**
 * The issuing state, from the two places a licence front actually says it.
 *
 * The HEADER carries the state's full name — "ARIZONA DRIVER LICENSE" — on
 * every US card, so that is read first. The two-letter code only ever appears
 * in the address line, and looking for a bare one is how "LA PAZ" becomes
 * Louisiana and a street "N OR..." becomes Oregon; so the code is a fallback
 * and only counts where a ZIP follows it, the shape an address line has.
 */
const STATE_NAMES: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
  COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA',
  HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA',
  KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD',
  MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS',
  MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK',
  OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT',
  VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI',
  WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC',
}

/** Longest name first, so WEST VIRGINIA is not read as VIRGINIA. */
const STATE_NAME_RE = new RegExp(
  '\\b(' + Object.keys(STATE_NAMES).sort((a, b) => b.length - a.length).join('|') + ')\\b',
)

/** A postal code in address position: CODE then a ZIP. */
const STATE_IN_ADDRESS = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b[ ,]+\d{5}(?:-\d{4})?\b/

function issuingStateFrom(upper: string): string | undefined {
  const byName = STATE_NAME_RE.exec(upper)
  if (byName) return STATE_NAMES[byName[1]]
  const byCode = STATE_IN_ADDRESS.exec(upper)
  return byCode ? byCode[1] : undefined
}

/** MM/DD/YYYY as a licence prints it, to YYYY-MM-DD. */
function usDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const m = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/.exec(raw)
  if (!m) return undefined
  const [, mm, dd, yyyy] = m
  const M = Number(mm), D = Number(dd), Y = Number(yyyy)
  if (Y < 1900 || Y > 2200) return undefined
  // 10/29 (review): a real day, not merely 1-31. "DOB 02/31/1980" is an
  // ordinary OCR misread, and it used to reach a ::date cast and raise inside
  // the caller's open transaction — losing the guest's whole capture.
  if (!isRealDay(Y, M, D)) return undefined
  return `${Y}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`
}

/**
 * Pull the fields out of whatever the OCR saw.
 *
 * Driven off the LABELS a licence prints beside each field — DL, DOB, EXP —
 * because those are the one thing every state has in common, where the layout
 * and the fonts are not. A field whose label was not read is simply absent:
 * guessing which loose number on the card is the licence number is how a
 * matcher ends up confidently wrong about who somebody is.
 */
export function extractFrontFields(text: string): Omit<FrontRead, 'confidence' | 'text'> {
  const flat = text.replace(/\r/g, '')
  const out: Omit<FrontRead, 'confidence' | 'text'> = {}

  // DOB and EXP are both dates; the label says which is which.
  const dob = /\bDOB\b[^\n]*/i.exec(flat)
  if (dob) out.dateOfBirth = usDate(dob[0])
  const exp = /\b(EXP|EXPIRES|EXPIRATION)\b[^\n]*/i.exec(flat)
  if (exp) out.expiryDate = usDate(exp[0])

  // The licence number, by its label. Tesseract reads 'DL' and '4d' (the
  // AAMVA field code some states print) and occasionally 'LIC'.
  const dl = /\b(DL|DLN|LIC|LICENSE\s*NO|ID\s*NO|4d)\b[:\s]*([A-Z0-9][A-Z0-9\- ]{3,20})/i.exec(flat)
  if (dl) {
    const n = normalizedIdNumber(dl[2])
    // A 'number' that is all letters is a word the OCR ran into, not an id.
    if (n && /\d/.test(n)) out.idNumber = n
  }

  const st = issuingStateFrom(flat.toUpperCase())
  if (st) out.issuingState = st
  return out
}

/**
 * Read a photograph of the FRONT of a licence. Never throws: a failed read is
 * an empty result, and the guest's typing or the barcode carries the record.
 */
export async function readLicenceFront(filePath: string): Promise<FrontRead | null> {
  try {
    const { createWorker } = await import('tesseract.js')
    // ── 10/29 (review follow-on): AN UNREADABLE PHOTO MUST NOT CRASH THE API ─
    //
    // Without an errorHandler, tesseract.js does BOTH things when a job fails
    // (createWorker.js:241-247): it rejects the awaited promise — which the
    // catch below handles — and then `throw Error(data)` from inside the WORKER
    // THREAD's message handler. That second throw is an uncaught exception, not
    // a rejection, so no try/catch anywhere on the call path can see it. On this
    // path that is reached from a sign-in-free upload route, which makes one
    // corrupt or truncated photo a way to take the API process down.
    //
    // Found by the two new tests that deliberately hand it a file that is not an
    // image: both passed and both left an uncaught exception behind them in the
    // run. Supplying the handler suppresses the throw and leaves the rejection,
    // which is the behaviour this function was already written for.
    const worker = await createWorker('eng', undefined, {
      // ── 10/29 (Ben, for the cloud image): THE MODEL IS OURS AND LOCAL ──────
      //
      // Asked whether this loads its traineddata locally or from the default
      // CDN. It was the CDN. With no `langPath` the library fetches
      // cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int at RUNTIME
      // (worker-script/index.js:126-129, comment and all), and with no
      // `cachePath` it then writes the 5MB model into the process's working
      // directory (line 111 reads `${cachePath || '.'}`, line 178 writes it).
      // That is where the untracked eng.traineddata at the repo root came
      // from — it appeared the first time these tests ran.
      //
      // Three things wrong with that, and only one of them is about the cloud:
      //   · a core data-processing path reached out to a third-party CDN on
      //     first use, against the no-external-CDN posture, and a park with no
      //     internet could not read a licence;
      //   · it wrote 5MB into cwd, which a read-only or ephemeral container
      //     either refuses or throws away on every cold start, re-downloading;
      //   · nothing declared the dependency, so it was invisible until
      //     something looked.
      //
      // So the model is vendored at apps/api/assets/tessdata and named here. Resolved
      // from this module rather than cwd, because `src/services` and
      // `dist/services` are both two levels under apps/api. cacheMethod 'none'
      // stops the runtime write entirely: the file we ship is the only copy.
      langPath:    path.join(__dirname, '..', '..', 'assets', 'tessdata'),
      // The library expects `<lang>.traineddata.gz` unless told otherwise
      // (`gzip = true` is its default, worker-script/index.js:78). The model
      // committed here is the plain uncompressed one, so this must say so —
      // and it has to, because getting it wrong fails SILENTLY in the worst
      // way available: errorHandler swallows the missing-file error, every
      // front read comes back unreadable, and the whole feature degrades to
      // "send it all to a human" without one test going red.
      gzip:        false,
      cacheMethod: 'none',
      errorHandler: (err: unknown) =>
        logger.warn({ err }, '[licence-front] the OCR engine rejected a job'),
    })
    try {
      const { data } = await worker.recognize(filePath)
      const text = String(data?.text ?? '')
      if (!text.trim()) return null
      return { ...extractFrontFields(text), confidence: Number(data?.confidence ?? 0), text }
    } finally { await worker.terminate().catch(() => {}) }
  } catch (err) {
    logger.warn({ err }, '[licence-front] the OCR could not read this one')
    return null
  }
}

/**
 * How well the front has read for a state, measured against the barcode.
 *
 * Returns null when there is not enough evidence to say — which is NOT the
 * same as a bad score, and is treated the same way by the caller: a person
 * looks until the figure exists.
 */
export async function stateFrontAccuracy(
  client: Pick<PoolClient, 'query'>, state: string | null | undefined,
): Promise<{ pct: number; sample: number } | null> {
  if (!state) return null
  const r = await client.query<{ n: string; hit: string }>(
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
      SELECT COUNT(*)::text AS n,
             COUNT(*) FILTER (WHERE id_number_agreed AND dob_agreed IS NOT FALSE)::text AS hit
        FROM one_per_card
       WHERE issuing_state = $1`,
    [String(state).toUpperCase()])
  const n = Number(r.rows[0]?.n ?? 0)
  if (n < FRONT_OCR_MIN_SAMPLE) return null
  return { pct: Math.round((Number(r.rows[0].hit) / n) * 1000) / 10, sample: n }
}

/**
 * Record one front read, grade it against the barcode where there is one, and
 * decide whether a person has to look.
 *
 * The rule, in his words and in this order:
 *   · the two disagree          → a person looks. Something is wrong and we do
 *                                 not know which side.
 *   · no barcode, and the state
 *     does not read well enough  → a person looks.
 *   · no barcode, and no figure
 *     for that state yet         → a person looks. Silence is not a pass.
 *   · otherwise                  → trusted.
 */
export async function recordFrontRead(args: {
  client:           PoolClient
  identificationId: string
  read:             FrontRead | null
  /** What the barcode gave, when the back was readable. */
  truth?:           { idNumber?: string; dateOfBirth?: string } | null
}): Promise<{ needsReview: boolean; reason: string | null }> {
  const c = args.client
  const read = args.read
  const state = read?.issuingState ?? null
  const truthNum = normalizedIdNumber(args.truth?.idNumber)
  const readNum = normalizedIdNumber(read?.idNumber)

  const gradeable = !!truthNum || !!args.truth?.dateOfBirth
  const numAgreed = gradeable && truthNum ? readNum === truthNum : null
  const dobAgreed = gradeable && args.truth?.dateOfBirth
    ? (read?.dateOfBirth ?? null) === args.truth.dateOfBirth : null

  await c.query(
    `INSERT INTO id_front_reads
       (identification_id, issuing_state, read_id_number, read_dob, ocr_confidence,
        truth_id_number, truth_dob, id_number_agreed, dob_agreed)
     VALUES ($1,$2,$3,$4::date,$5,$6,$7::date,$8,$9)`,
    [args.identificationId, state, read?.idNumber ?? null, read?.dateOfBirth ?? null,
     read?.confidence ?? null, truthNum, args.truth?.dateOfBirth ?? null,
     numAgreed, dobAgreed])

  let reason: string | null = null
  if (gradeable && (numAgreed === false || dobAgreed === false)) {
    reason = 'The front and the barcode do not agree — someone needs to look at the pictures.'
  } else if (!gradeable) {
    const acc = await stateFrontAccuracy(c, state)
    if (!acc) {
      reason = state
        ? `No barcode, and GAM has not read enough ${state} licences yet to trust the front on its own.`
        : 'No barcode, and the front did not even say which state issued it.'
    } else if (acc.pct < FRONT_OCR_TRUST_PCT) {
      reason = `No barcode, and the front reads correctly only ${acc.pct}% of the time in ${state} `
        + `(${acc.sample} checked), so this one is confirmed by hand.`
    }
  }

  if (reason) {
    await c.query(
      `UPDATE tenant_identifications
          SET needs_review = TRUE, review_reason = $2, updated_at = NOW()
        WHERE id = $1`, [args.identificationId, reason])
  }
  return { needsReview: !!reason, reason }
}
