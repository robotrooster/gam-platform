/**
 * ── THE PHOTO ID A GUEST GIVES WHEN THEY PAY (Nic, 10/29) ───────────────────
 *
 *   "When they confirm to pay the deposit, it's add a picture of your photo
 *    ID. It's very commonplace. When you book a hotel anywhere, if you pay
 *    with a credit card, you have to show ID as the person that paid with that
 *    credit card... I want every flow to happen where people's identity is
 *    verified."
 *
 * WHY IT IS ONLY THE SHORT STAYS. At STAY_SCREENING_NIGHTS (22) a background
 * check is already required and Checkr establishes who somebody is properly.
 * The gap is underneath that — and it is not a small one, because the nights
 * are counted on a CONTINUOUS stay at ONE property. A person doing a fortnight
 * here and a fortnight there never reaches 22 anywhere, so nobody ever screens
 * them, which is exactly the resident the left-owing collection exists for.
 * Their licence is the only thing that says they are the same person as the
 * one who left a balance two parks ago.
 *
 * WHY THE SERVER READS IT. Nic: "if they're uploading the picture, can't our
 * system just do the decoding on the server side?" Yes, and it is the better
 * answer — every licence carries a PDF417 barcode holding the name, birthday,
 * number and address as text, and reading it here means one implementation for
 * every phone instead of a decoder in the browser that works on Android and
 * not on an iPhone. The guest's phone only has to take a photograph.
 *
 * WHEN THE READ FAILS, NOTHING BREAKS. Glare, an angle, a worn card: the photo
 * is still filed, and whatever the guest typed stands. A failed decode must
 * never be the reason somebody cannot pay a deposit, so every path here
 * returns rather than throws.
 */
import type { PoolClient } from 'pg'
import fs from 'fs'
import { parseIdScan, normalizedIdNumber, type ScannedId } from '@gam/shared'
import type { FrontRead } from './licenceFrontOcr'
import { logger } from '../lib/logger'

/** What the guest typed, if anything — always allowed alongside the photo. */
export interface TypedId {
  firstName?: string | null
  lastName?: string | null
  /** YYYY-MM-DD. */
  dateOfBirth?: string | null
  idNumber?: string | null
  issuingState?: string | null
}

/** Nothing was filed — either the guest skipped, or the photo needs retaking. */
export interface NotCaptured {
  filed: false
  /** Present when a photo was sent and could not be read: show it, offer a retake. */
  readFailed?: string
  /**
   * 10/29 (review): a GAM admin has already confirmed this one by hand, so the
   * unauthenticated page may not replace it. Shown to the guest as "already on
   * file" — there is nothing for them to do and nothing has gone wrong.
   */
  alreadyConfirmed?: true
}

export interface CapturedId {
  filed: true
  identificationId: string
  /** Whether the barcode on the photo was read, or the guest's typing stands. */
  capturedHow: 'scanned' | 'typed'
  /** What is on file now, from the read where it worked and the typing where it did not. */
  fields: ScannedId
  /**
   * Set when a photo was sent and could not be read — the sentence to show
   * the guest so they can take another. The capture still SUCCEEDED: the
   * photo is filed either way, and whatever they typed stands.
   */
  readFailed?: string
}

/**
 * Why a photograph could not be read, in the words the guest is shown.
 *
 * 10/29 (Nic): "if the customer scans a picture of their ID and it can't be
 * read, it should know that and prompt the customer, hey, that picture was
 * bad, either retake it."
 *
 * So a failure is never silent and never just "that didn't work". The barcode
 * is on the BACK of every licence, and photographing the front is both the
 * commonest mistake and indistinguishable from a blurred read — the symbol is
 * simply not there either way. So the message says the thing most likely to
 * fix it rather than guessing at a cause it cannot know.
 */
export const ID_READ_FAILED =
  'We could not read the barcode. It is on the BACK of the licence — hold the '
  + 'card flat, get the whole card in the frame, and avoid glare.'

export type ReadOutcome =
  | { ok: true;  fields: ScannedId }
  | { ok: false; reason: string }

/**
 * Read the PDF417 on the back of a licence out of an uploaded photograph.
 *
 * Never throws. A failure comes back with the sentence to show the guest, so
 * the screen can offer another go rather than falling silently through to
 * typing.
 */
export async function readLicencePhoto(filePath: string): Promise<ReadOutcome> {
  try {
    const [{ default: Jimp }, zx] = await Promise.all([
      import('jimp') as any,
      import('@zxing/library'),
    ])
    const img = await Jimp.read(filePath)
    const { width: w, height: h, data } = img.bitmap
    // A phone photo is far larger than the symbol needs, and the decoder gets
    // slower and no more accurate on pixels it does not use.
    const luminance = new Int32Array(w * h)
    for (let i = 0, p = 0; i < luminance.length; i++, p += 4) {
      luminance[i] = (0xFF << 24) | (data[p] << 16) | (data[p + 1] << 8) | data[p + 2]
    }
    const bitmap = new zx.BinaryBitmap(
      new zx.HybridBinarizer(new zx.RGBLuminanceSource(luminance, w, h)))
    const hints = new Map([[zx.DecodeHintType.TRY_HARDER, true]])
    const text = new zx.PDF417Reader().decode(bitmap, hints).getText()
    const fields = parseIdScan(text)
    // A symbol that decoded but carries nothing identifying is a failed read,
    // not a person with no name — most likely some other barcode on the card.
    return fields ? { ok: true, fields } : { ok: false, reason: ID_READ_FAILED }
  } catch {
    // ZXing throws a bare NotFoundException when it cannot see a symbol, which
    // is the ordinary case for a photo of the FRONT of a licence. Not an error
    // worth logging on every upload.
    return { ok: false, reason: ID_READ_FAILED }
  }
}

/**
 * File a guest's ID against their stay: the photo as the record, the read
 * where it worked, the typing where it did not.
 *
 * Idempotent per booking — a guest who uploads twice replaces what was there,
 * because the later photo is the one they meant.
 */
export async function captureGuestId(args: {
  client:      PoolClient
  bookingId:   string
  /** Where the uploaded photo was stored, and how it is served back. */
  filePath:    string | null
  documentUrl: string | null
  typed?:      TypedId
  capturedBy?: string | null
  /**
   * 10/29 (Nic): "We should get the picture of the front and the back... In
   * case the barcode is unreadable or only partially read or whatever, we can
   * have the parser pull the information off the front."
   *
   * So the front is both the copy a park keeps and a second reader. It runs
   * through local OCR (`licenceFrontOcr.ts`) — a different and much harder
   * engine than barcode decoding, over a hologram, in a layout that differs by
   * state — which is why its answer is a PRE-FILL and a cross-check and never
   * beats the barcode.
   */
  frontUrl?: string | null
  /** Where the FRONT photo landed on disk, so the OCR can read it. */
  frontPath?: string | null
  /**
   * The guest has finished retaking and the photo is kept as it is — filed
   * with whatever was read or typed, even if that is nothing but the picture.
   */
  keepUnreadable?: boolean
  /**
   * ── 10/29 (review): THE IMAGE READS DO NOT BELONG IN THE TRANSACTION ──────
   *
   * Decoding a PDF417 and running tesseract are multi-second passes over a
   * photo of up to 12MB, and they were both happening between BEGIN and COMMIT
   * on a route with no sign-in. A pooled connection sat idle-in-transaction for
   * the length of both, holding the identification's row lock for the second —
   * so roughly DB_POOL_MAX concurrent uploads (20) could hold every connection
   * the API has, and everything else, rent payments included, would queue
   * behind a stranger's camera roll.
   *
   * Neither read needs the database, so a caller can do them FIRST and hand the
   * answers in. Passing either (even as null) skips that read here; omitting
   * them keeps the old behaviour for callers where it does not matter, like the
   * front desk.
   */
  backRead?:  ReadOutcome | null
  frontRead?: FrontRead | null
}): Promise<CapturedId | NotCaptured> {
  const outcome = args.backRead !== undefined
    ? args.backRead
    : (args.filePath ? await readLicencePhoto(args.filePath) : null)
  const scanned = outcome?.ok ? outcome.fields : null
  const typed = args.typed ?? {}

  // The read wins where it has an answer: it came off the card itself and
  // cannot fat-finger a digit. Typing fills everything it did not reach.
  //
  // AND TYPING GOES THROUGH THE SAME NORMALIZER THE READ DOES. A number
  // stored as the guest happened to punctuate it — "d-123 4567" — is a number
  // no later match can find, which defeats the whole reason the licence is
  // collected: telling two people with the same name apart. One spelling per
  // card, whichever way it arrived.
  const fields: ScannedId = {
    firstName:    scanned?.firstName    ?? typed.firstName    ?? undefined,
    lastName:     scanned?.lastName     ?? typed.lastName     ?? undefined,
    middleName:   scanned?.middleName,
    dateOfBirth:  scanned?.dateOfBirth  ?? typed.dateOfBirth  ?? undefined,
    idNumber:     scanned?.idNumber     ?? (normalizedIdNumber(typed.idNumber) ?? undefined),
    issuingState: scanned?.issuingState
                  ?? (typed.issuingState ? typed.issuingState.trim().toUpperCase() : undefined),
    issuingCountry: scanned?.issuingCountry ?? 'US',
    expiryDate:   scanned?.expiryDate,
    street:       scanned?.street,
    city:         scanned?.city,
    postalCode:   scanned?.postalCode,
  }

  const haveSomething = !!(fields.idNumber || fields.dateOfBirth)

  // ── 10/29 (Nic): A BAD PHOTO IS A RETAKE, NOT A RECORD ───────────────────
  //
  //   "If the customer scans a picture of their ID and it can't be read, it
  //    should know that and prompt the customer, hey, that picture was bad,
  //    either retake it. It gives them a chance to retake it or a couple of
  //    chances to retake it. And then if it can't be collected, then they just
  //    type it in."
  //
  // So an unreadable photo with nothing typed beside it files NOTHING and
  // comes back with the reason: the guest is offered another go, and the
  // record is not polluted with a row that identifies nobody. Only when they
  // have finished trying — the screen says so with `keepUnreadable` — is the
  // photo kept on its own, which is still worth having: it is the copy of the
  // licence a park wanted in the first place.
  if (!haveSomething && !args.keepUnreadable) {
    return outcome && !outcome.ok
      ? { filed: false, readFailed: outcome.reason }
      : { filed: false }
  }
  // Nothing identifying and no picture of either side: the guest skipped the
  // step, which is not an error.
  if (!haveSomething && !args.documentUrl && !args.frontUrl) return { filed: false }

  // ── 10/29 (review): A CONFIRMED IDENTIFICATION IS NOT OVERWRITTEN ─────────
  //
  // decideFrontReview deliberately refuses a SECOND admin decision ("Somebody
  // has already confirmed this one"), but nothing stopped an unauthenticated
  // POST on the capture token rewriting the same row afterwards. The upsert
  // touches none of needs_review, reviewed_at, reviewed_by or verified_at, so a
  // different person's cleanly-barcoding licence could replace the number, the
  // birthday and both photographs while the row still read as verified and
  // still named the admin who had vouched for the old one. Their stamp would be
  // standing behind data they never saw.
  //
  // So once a person at GAM has decided it, this door is shut. A correction
  // after that point is theirs to make, with their name on it.
  const confirmed = await args.client.query<{ id: string }>(
    `SELECT id FROM tenant_identifications
      WHERE booking_id = $1 AND reviewed_at IS NOT NULL`, [args.bookingId])
  if (confirmed.rows.length) {
    logger.warn({ booking_id: args.bookingId },
      '[guest-id] a capture was offered for an identification GAM has already confirmed — not replaced')
    return { filed: false, alreadyConfirmed: true }
  }

  const row = await args.client.query<{ id: string }>(
    `INSERT INTO tenant_identifications
       (booking_id, id_type, id_number, issuing_state, issuing_country,
        expiry_date, document_url, document_front_url, date_of_birth,
        captured_how, captured_by, is_primary)
     VALUES ($1, 'drivers_license', $2, $3, $4, $5::date, $6, $10, $7::date, $8, $9, TRUE)
     ON CONFLICT (booking_id) WHERE booking_id IS NOT NULL DO UPDATE
        -- ── 10/29 (review): THE NUMBER IS NEVER BLANKED ──────────────────
            --
            -- This was the one column in the list written unconditionally,
            -- while every other field was kept if it was already there. The
            -- value inserted is the idNumber-or-empty-string placeholder, so a
            -- guest who came back to add the front picture the park asked for,
            -- reading nothing new and typing nothing, overwrote a good number
            -- with an empty string. needs_review stayed false and verified_at
            -- stayed set, so the row still read as a verified identification
            -- with no number in it, and normalizedIdNumber('') is null, so the
            -- licence quietly stopped being a match point at every other park.
            -- The one field the whole feature exists to hold.
            SET id_number     = COALESCE(NULLIF(EXCLUDED.id_number, ''), tenant_identifications.id_number),
            issuing_state = COALESCE(EXCLUDED.issuing_state, tenant_identifications.issuing_state),
            expiry_date   = COALESCE(EXCLUDED.expiry_date, tenant_identifications.expiry_date),
            -- Each side is kept if it was ever sent: a guest retaking only the
            -- back must not wipe the front they already gave.
            document_url       = COALESCE(EXCLUDED.document_url, tenant_identifications.document_url),
            document_front_url = COALESCE(EXCLUDED.document_front_url, tenant_identifications.document_front_url),
            date_of_birth = COALESCE(EXCLUDED.date_of_birth, tenant_identifications.date_of_birth),
            -- A card that was once SCANNED stays scanned: a later front-only
            -- upload reads nothing, and letting it write 'typed' would downgrade
            -- the provenance of a number the barcode actually gave us.
            captured_how  = CASE WHEN tenant_identifications.captured_how = 'scanned'
                                 THEN 'scanned' ELSE EXCLUDED.captured_how END,
            captured_by   = EXCLUDED.captured_by,
            updated_at    = NOW()
     RETURNING id`,
    [args.bookingId,
     // The number is what another park matches on, so it is stored as read.
     // An unreadable card with a photo on file still files, with a placeholder
     // nobody can match on by accident.
     fields.idNumber ?? '',
     fields.issuingState ?? null, fields.issuingCountry ?? 'US',
     fields.expiryDate ?? null, args.documentUrl,
     fields.dateOfBirth ?? null,
     scanned ? 'scanned' : 'typed', args.capturedBy ?? null,
     args.frontUrl ?? null])

  // The birthday also goes on the booking, where the left-owing matcher looks
  // for a guest who has no tenant record of any kind.
  if (fields.dateOfBirth) {
    await args.client.query(
      `UPDATE unit_bookings SET guest_date_of_birth = $2::date, updated_at = NOW()
        WHERE id = $1 AND guest_date_of_birth IS DISTINCT FROM $2::date`,
      [args.bookingId, fields.dateOfBirth])
  }

  /**
   * ── AND THE FRONT IS READ AND GRADED (Nic, 10/29) ─────────────────────────
   *
   * This is where the barcode earns its second job. Where BOTH sides came in,
   * the back decoded exactly, so it is the answer key for the front: the read
   * grades itself on a real card from a real state, free, and that is what
   * turns "how accurate is the OCR in Arizona" into a measurement instead of a
   * guess.
   *
   * Where only the front came in there is no key, so the decision is the
   * state's record: a state that reads well goes through, a state that does
   * not — or has not been measured — goes to a person at GAM.
   *
   * Best-effort on purpose. The identification is already filed; a reading
   * engine falling over must not lose a guest their capture.
   */
  const identificationId = row.rows[0].id
  if (args.frontPath) {
    // ── 10/29 (review): A SAVEPOINT, NOT JUST A CATCH ───────────────────────
    //
    // recordFrontRead writes on the CALLER's open transaction, and catching its
    // error is not enough: a Postgres error has already aborted that
    // transaction, so the identification INSERT above was gone and the caller's
    // COMMIT was silently treated as a ROLLBACK. The guest was told "your
    // licence is on file", the photos sat on disk with no row pointing at them
    // — so the per-row file auth would not even serve them to an admin — and
    // nothing reached the review queue. A best-effort read has to be able to
    // fail without taking the capture with it, which is what a SAVEPOINT is for.
    await args.client.query('SAVEPOINT front_read')
    try {
      const { readLicenceFront, recordFrontRead } = await import('./licenceFrontOcr')
      const front = args.frontRead !== undefined
        ? args.frontRead
        : await readLicenceFront(args.frontPath)
      await recordFrontRead({
        client: args.client,
        identificationId,
        read: front,
        // Only the BARCODE is an answer key. What the guest typed is not: a
        // person reading their own card off a screen is exactly as likely to
        // mistype it as the OCR is to misread it, and grading one guess
        // against another would manufacture a percentage out of nothing.
        truth: scanned
          ? { idNumber: scanned.idNumber, dateOfBirth: scanned.dateOfBirth }
          : null,
      })
      await args.client.query('RELEASE SAVEPOINT front_read')
    } catch (err) {
      await args.client.query('ROLLBACK TO SAVEPOINT front_read')
      await args.client.query('RELEASE SAVEPOINT front_read')
      logger.warn({ err, identificationId }, '[guest-id] the front could not be read or graded')
    }
  }

  logger.info({ booking_id: args.bookingId, how: scanned ? 'scanned' : 'typed',
                read_failed: outcome && !outcome.ok ? true : undefined },
    '[guest-id] identification filed')
  return {
    filed: true,
    identificationId,
    capturedHow: scanned ? 'scanned' : 'typed',
    fields,
    ...(outcome && !outcome.ok ? { readFailed: outcome.reason } : {}),
  }
}

/** Tidy up a photo that was read but is not being kept. */
export function discardPhoto(filePath: string | null): void {
  if (!filePath) return
  try { fs.unlinkSync(filePath) } catch { /* already gone */ }
}

export { normalizedIdNumber }
