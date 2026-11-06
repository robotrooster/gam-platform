/**
 * ── THE GUEST'S OWN CAMERA, ON THE GUEST'S OWN PHONE (Nic, 10/29) ──────────
 *
 *   "The better way I see building this is not the front counter doing the
 *    scan. It's the tenant getting a link in their reservation stay and
 *    scanning with their own camera on their own phone... let's just revert it
 *    to upload a picture, because not every front counter is going to buy
 *    extra hardware."
 *
 * And on where the ask sits:
 *
 *   "Deposit is already paid during booking for people that do it online. For
 *    people that call in to make a reservation, it's the way I said it. It
 *    emails them a link for a deposit. Ask for the ID during the deposit
 *    checkout that they already go through. No sign in, no flow change."
 *
 * WHY NO SIGN-IN. A guest paying for one night has no reason to hold an
 * account, and asking them to make one to hand over their licence would lose
 * most of them. The link's token is the key, and it opens exactly one thing:
 * attaching an identification to ONE booking. It is not a payment credential
 * and it reveals nothing about the stay but the property's name.
 *
 * WHY THE SERVER DOES THE READING. Nic: "why would Android or iPhone need the
 * decoder? If they're uploading the picture, can't our system just do the
 * decoding on the server side?" — right, and it also means every phone works,
 * including one with a camera too poor to decode live.
 *
 * NOTHING IS REQUIRED. A guest may skip, may retake, or may type the card out
 * by hand, and a stay is never blocked on any of it. A licence is how two
 * people with the same name are told apart later; it is not a turnstile.
 */
import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { page, escapeHtml } from './posPayLinks'
import { captureGuestId, discardPhoto, ID_READ_FAILED, readLicencePhoto } from '../services/guestIdCapture'
import { readLicenceFront } from '../services/licenceFrontOcr'
import { resolveUploadPath } from '../lib/uploadPaths'
import { apiLink } from '../lib/portalUrls'
import { requireAuth, requireAdmin } from '../middleware/auth'

export const publicGuestIdRouter = Router()

/**
 * Its own directory, never the screening store. The per-row auth that serves
 * these back can then never hand out one as the other, which is the same
 * reason proof-of-income got its own (S636).
 */
const licenceDir = path.join(process.cwd(), 'uploads', 'guest-licences')
if (!fs.existsSync(licenceDir)) fs.mkdirSync(licenceDir, { recursive: true })

/**
 * ── 10/29 (review): THE EXTENSION IS OURS, NOT THE GUEST'S ──────────────────
 *
 * The stored name took its extension from `path.extname(file.originalname)`,
 * and the filter only looked at `file.mimetype` — BOTH client-supplied. So a
 * guest could POST a part declared `image/png` whose filename was `x.html` and
 * whose bytes were a script, and it landed on disk as `<ts>-<hex>.html`. The
 * serving route then removed the CSP header and let express derive
 * `text/html` from that extension, which is stored XSS aimed at the one
 * browser that opens these — a GAM admin's, on the admin portal's own origin.
 *
 * So the extension is derived HERE from the accepted type, and pinned again on
 * the way out (EXT_TO_MIME below). This is the same posture the repo already
 * settled on four times over — S380 avatars, S394 esign, S399 unit photos,
 * S409 avatar serve — and the one new upload route skipped it.
 */
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/heic': '.heic', 'image/webp': '.webp',
}

const licenceUpload = multer({
  storage: multer.diskStorage({
    destination: licenceDir,
    filename: (_req, file, cb) =>
      cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex')
             + (MIME_TO_EXT[file.mimetype] ?? '.jpg')),
  }),
  // A phone photo of a licence; PDFs are not accepted because neither reader
  // can see a barcode or a word inside one.
  limits: { fileSize: 12 * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, cb) => {
    if (MIME_TO_EXT[file.mimetype]) cb(null, true)
    else cb(new Error('photo only'))
  },
})

const photoFields = licenceUpload.fields([{ name: 'back', maxCount: 1 }, { name: 'front', maxCount: 1 }])

/** A bad file is the person's mistake, so it comes back in words they can act on. */
const photos = (req: any, res: any, next: any) => photoFields(req, res, (err: any) => {
  if (!err) return next()
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return next(new AppError(400, 'That photo is over 12MB. Take it again at a normal size.'))
  }
  if (typeof err?.message === 'string' && err.message.includes('photo only')) {
    return next(new AppError(400, 'That has to be a photo — a JPEG, PNG, HEIC or WebP.'))
  }
  return next(err)
})

export const guestIdUrl = (token: string) => apiLink(`api/public/id/${token}`)

/** Mint (or reuse) the capture link for a booking. Reusing matters: a guest who
 *  opens the email twice must land on the same page, not a dead one. */
export async function guestIdCaptureLink(bookingId: string): Promise<string> {
  const row = await queryOne<{ id_capture_token: string | null }>(
    `UPDATE unit_bookings
        SET id_capture_token = COALESCE(id_capture_token, $2),
            id_capture_asked_at = COALESCE(id_capture_asked_at, NOW()),
            updated_at = NOW()
      WHERE id = $1 RETURNING id_capture_token`,
    [bookingId, crypto.randomBytes(24).toString('hex')])
  if (!row?.id_capture_token) throw new AppError(404, 'That reservation is not on the schedule')
  return guestIdUrl(row.id_capture_token)
}

interface TokenBooking {
  id: string
  guest_name: string | null
  property_name: string
  have_front: boolean
  have_back: boolean
  have_number: boolean
}

async function bookingForToken(token: string): Promise<TokenBooking | null> {
  if (!/^[a-f0-9]{48}$/.test(token)) return null
  return queryOne<TokenBooking>(
    `SELECT b.id, b.guest_name, p.name AS property_name,
            (i.document_front_url IS NOT NULL) AS have_front,
            (i.document_url IS NOT NULL) AS have_back,
            (COALESCE(i.id_number, '') <> '') AS have_number
       FROM unit_bookings b
       JOIN units u ON u.id = b.unit_id
       JOIN properties p ON p.id = u.property_id
       LEFT JOIN tenant_identifications i ON i.booking_id = b.id
      WHERE b.id_capture_token = $1
        -- ── 10/29 (review): THE LINK IS FOR A STAY THAT IS STILL HAPPENING ──
        --
        -- This matched on the token alone: no status, no dates, and the token
        -- is never rotated or cleared. So a reservation email — the guest's, or
        -- whoever it was forwarded to — stayed a live write capability over
        -- that booking's identification for ever, long after the stay was
        -- checked out or called off.
        AND b.status IN ('tentative', 'confirmed', 'checked_in')`, [token])
}

const FIELD_HELP = 'Only what is printed on the card — nothing else is asked for.'

function capturePage(token: string, b: TokenBooking, said?: {
  kind: 'retake' | 'done' | 'typed'; words: string
}): string {
  const first = (b.guest_name || '').split(' ')[0]
  const banner = said
    ? `<p style="background:${said.kind === 'retake' ? '#3a2a12;border:1px solid #6b4a16' : '#15301c;border:1px solid #2a5c38'};`
      + `padding:10px 12px;border-radius:9px;margin:0 0 14px">${escapeHtml(said.words)}</p>`
    : ''
  // The whole card is optional, and the page says so where the guest can see it
  // rather than in small print at the bottom.
  const body = `
<h1>${first ? `${escapeHtml(first)}, add` : 'Add'} a photo of your licence</h1>
<p style="margin:0 0 14px">${escapeHtml(b.property_name)} keeps a copy on file for your stay. It takes two pictures and you can skip it.</p>
${banner}
<form method="post" action="/api/public/id/${token}" enctype="multipart/form-data">
  <label style="display:block;margin:0 0 4px" class="g">Back of the card</label>
  <p style="margin:0 0 8px;font-size:.9rem">The barcode is on this side — it is what saves you typing.</p>
  <input type="file" name="back" accept="image/*" capture="environment"
         style="width:100%;margin:0 0 18px"${b.have_back ? ' ' : ''}>
  <label style="display:block;margin:0 0 4px" class="g">Front of the card</label>
  <input type="file" name="front" accept="image/*" capture="environment" style="width:100%;margin:0 0 18px">
  <button type="submit" style="width:100%;background:#c9a227;color:#0a0b0e;border:0;border-radius:9px;padding:13px;font-weight:700;font-size:1rem">
    ${b.have_back || b.have_front ? 'Send these' : 'Send the pictures'}
  </button>
</form>
<details style="margin-top:18px">
  <summary style="cursor:pointer">Type it in instead</summary>
  <p style="font-size:.9rem;margin:8px 0">${FIELD_HELP}</p>
  <form method="post" action="/api/public/id/${token}">
    <input name="firstName" placeholder="First name" style="width:100%;margin-bottom:8px;padding:10px;border-radius:8px;border:1px solid #252d42;background:#0f111a;color:#e8ecf5">
    <input name="lastName" placeholder="Last name" style="width:100%;margin-bottom:8px;padding:10px;border-radius:8px;border:1px solid #252d42;background:#0f111a;color:#e8ecf5">
    <input name="idNumber" placeholder="Licence number" style="width:100%;margin-bottom:8px;padding:10px;border-radius:8px;border:1px solid #252d42;background:#0f111a;color:#e8ecf5">
    <input name="issuingState" placeholder="State (e.g. AZ)" maxlength="2" style="width:100%;margin-bottom:8px;padding:10px;border-radius:8px;border:1px solid #252d42;background:#0f111a;color:#e8ecf5">
    <input name="dateOfBirth" type="date" style="width:100%;margin-bottom:10px;padding:10px;border-radius:8px;border:1px solid #252d42;background:#0f111a;color:#e8ecf5">
    <button type="submit" style="width:100%;background:transparent;color:#c9a227;border:1px solid #c9a227;border-radius:9px;padding:11px;font-weight:600">Save what I typed</button>
  </form>
</details>`
  return page('Add your licence', body)
}

const notFound = () => page('Link not found',
  '<h1>This link isn’t valid</h1><p>Check the link in your email, or ask the office for a new one.</p>')

publicGuestIdRouter.get('/id/:token', async (req, res, next) => {
  try {
    const b = await bookingForToken(req.params.token)
    if (!b) return res.status(404).send(notFound())
    res.send(capturePage(req.params.token, b))
  } catch (e) { next(e) }
})

/**
 * The photos, or the typing, or both.
 *
 * A read that fails does NOT lose the upload and does not file a row that
 * identifies nobody: the guest is told the picture was bad and offered another
 * go, exactly as Nic asked —
 *
 *   "if the customer scans a picture of their ID and it can't be read, it
 *    should know that and prompt the customer, hey, that picture was bad,
 *    either retake it... And then if it can't be collected, then they just
 *    type it in. Or they can skip straight to typing it in the first place."
 *
 * The retake limit is the SECOND attempt, counted on what is already on file
 * rather than in a session: a guest whose first photo failed and who sends
 * another unreadable one has the picture kept as it is, because a third ask
 * reads as a wall and the picture itself is still the thing the park wanted.
 */
publicGuestIdRouter.post('/id/:token', photos, async (req: any, res, next) => {
  const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>
  const back = files.back?.[0] ?? null
  const front = files.front?.[0] ?? null
  try {
    const b = await bookingForToken(req.params.token)
    if (!b) {
      discardPhoto(back?.path ?? null); discardPhoto(front?.path ?? null)
      return res.status(404).send(notFound())
    }

    const typed = {
      firstName: String(req.body?.firstName ?? '').trim() || null,
      lastName: String(req.body?.lastName ?? '').trim() || null,
      idNumber: String(req.body?.idNumber ?? '').trim() || null,
      issuingState: (String(req.body?.issuingState ?? '').trim() || null)?.toUpperCase() ?? null,
      dateOfBirth: /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.dateOfBirth ?? ''))
        ? String(req.body.dateOfBirth) : null,
    }
    const nothingAtAll = !back && !front
      && !typed.idNumber && !typed.dateOfBirth && !typed.firstName && !typed.lastName
    if (nothingAtAll) return res.send(capturePage(req.params.token, b, {
      kind: 'retake', words: 'Nothing came through. Choose a photo, or type the card out below.' }))

    // Already tried once, so this attempt is the last: the photo is kept
    // whatever the reader makes of it.
    const secondGo = b.have_back || b.have_front

    // ── 10/29 (review): READ THE PICTURES BEFORE TAKING A CONNECTION ─────────
    //
    // Both passes are seconds long over an image of up to 12MB, and they used
    // to run between BEGIN and COMMIT — so ~20 concurrent uploads on this
    // sign-in-free endpoint could hold every connection in the pool and stall
    // the rest of the API, rent payments included. Neither needs the database.
    const backRead = back ? await readLicencePhoto(back.path) : null
    const frontRead = front ? await readLicenceFront(front.path) : null

    const c = await getClient()
    let out
    try {
      await c.query('BEGIN')
      out = await captureGuestId({
        client: c,
        bookingId: b.id,
        filePath: back?.path ?? null,
        documentUrl: back ? `/uploads/guest-licences/${back.filename}` : null,
        frontUrl: front ? `/uploads/guest-licences/${front.filename}` : null,
        frontPath: front?.path ?? null,
        typed,
        keepUnreadable: secondGo,
        backRead,
        frontRead,
      })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }

    if (!out.filed) {
      // Nothing was stored, so the photo on disk is rubbish — don't keep a
      // picture of somebody's licence that no row points at.
      discardPhoto(back?.path ?? null); discardPhoto(front?.path ?? null)
      // 10/29 (review): somebody at GAM has already confirmed this one by
      // hand, so it is not replaced. Nothing has gone wrong and there is
      // nothing for the guest to do — never a retake prompt, which would have
      // them photographing the card over and over against a shut door.
      if (out.alreadyConfirmed) {
        return res.send(capturePage(req.params.token, b, {
          kind: 'done',
          words: 'Your licence is already on file and checked — there is nothing more to send.' }))
      }
      return res.send(capturePage(req.params.token, b, {
        kind: 'retake', words: out.readFailed ?? ID_READ_FAILED }))
    }

    logger.info({ booking_id: b.id, how: out.capturedHow, second_go: secondGo },
      '[guest-id] a guest sent their licence')

    const words = out.readFailed
      // The picture is on file and that is what the park asked for; saying the
      // barcode did not read would make a success sound like a failure.
      ? 'Thank you — your licence is on file. We will read it by hand if we need to.'
      : out.capturedHow === 'scanned'
        ? 'Thank you — we read your licence and it is on file.'
        : 'Thank you — that is on file.'
    return res.send(page('Licence on file',
      `<h1>All set</h1><p>${escapeHtml(words)}</p>`
      + `<p>Nothing else is needed for ${escapeHtml(b.property_name)}.</p>`))
  } catch (e) {
    discardPhoto(back?.path ?? null); discardPhoto(front?.path ?? null)
    next(e)
  }
})

/**
 * ── SERVING THE PICTURE BACK, TO GAM ONLY (conservative by default) ────────
 *
 * A licence photograph is the most sensitive thing on this platform, so this
 * route serves it to a GAM admin and to nobody else. The GAM admin is the one
 * who has to look at it — confirming a front the OCR could not settle is their
 * job precisely because the landlord who stands to collect a left-owing debt
 * must not be the one who decides whose licence it is.
 *
 * DELIBERATELY NOT the owning landlord, though a park taking a paper copy is
 * ordinary practice and Nic may well want it: widening this later is one line,
 * and handing out licence images and then withdrawing them is not. Flagged to
 * him rather than decided here.
 */
export const guestIdFilesRouter = Router()

/** Content-Type pinned from OUR extension, the inverse of MIME_TO_EXT. */
const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.png': 'image/png', '.heic': 'image/heic', '.webp': 'image/webp',
}

guestIdFilesRouter.get('/guest-licence-files/:filename', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const fp = resolveUploadPath(licenceDir, req.params.filename)
    if (!fp || !fs.existsSync(fp)) throw new AppError(404, 'Not found')
    // Per-row, not just per-directory: the file must be one an identification
    // actually points at, so a filename guessed or kept from an older record
    // does not serve.
    const url = `/uploads/guest-licences/${req.params.filename}`
    const owner = await query<{ id: string }>(
      `SELECT id FROM tenant_identifications
        WHERE document_url = $1 OR document_front_url = $1 LIMIT 1`, [url])
    if (!owner.length) throw new AppError(404, 'Not found')
    // Pinned from OUR extension whitelist, never sniffed and never derived from
    // anything the guest sent: this response has its CSP removed so the admin
    // portal can render the photograph, which is exactly why it must not be
    // able to come back as a document. S398/S409 posture.
    res.setHeader('Content-Type', EXT_TO_MIME[path.extname(fp).toLowerCase()] ?? 'image/jpeg')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.removeHeader('Content-Security-Policy')
    res.removeHeader('Cross-Origin-Resource-Policy')
    res.sendFile(fp)
  } catch (e) { next(e) }
})
