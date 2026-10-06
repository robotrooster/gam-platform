// 10/5 (Nic) — photos of a bank's deposit receipt.
//
// Two kinds, one way of taking them: the landlord's photo on a payment they
// recorded as a bank deposit (routes/payments.ts), and the tenant's photo on
// their own "I paid at the bank" report (routes/declaredDeposits.ts). Images
// only, the same size cap, an unguessable file name, and each kind served by
// one authed route that authorizes per row — never a static URL.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import multer from 'multer'
import { BANK_DEPOSIT_PHOTO_TYPES, BANK_DEPOSIT_PHOTO_MAX_BYTES } from '@gam/shared'
import { AppError } from '../middleware/errorHandler'
import { canAccessLandlordResource } from '../middleware/scope'

const PHOTO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif',
}

/** The directory a kind of photo is kept in (created if missing). */
export function bankReceiptPhotoDir(name: string): string {
  const dir = path.join(process.cwd(), 'uploads', name)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Express middleware taking one photo (multipart field 'photo') into `dir`,
 * with multer's own refusals said in plain words.
 */
export function takeBankReceiptPhoto(dir: string) {
  const upload = multer({
    storage: multer.diskStorage({
      destination: dir,
      filename: (_req: any, file: any, cb: any) =>
        cb(null, Date.now() + '-' + crypto.randomBytes(12).toString('hex') + (PHOTO_EXT[file.mimetype] ?? '.img')),
    }),
    limits: { fileSize: BANK_DEPOSIT_PHOTO_MAX_BYTES, files: 1 },
    fileFilter: (_req: any, file: any, cb: any) => {
      if ((BANK_DEPOSIT_PHOTO_TYPES as readonly string[]).includes(file.mimetype)) cb(null, true)
      else cb(new AppError(400, 'Choose a photo (JPEG, PNG, WebP or HEIC) of the bank\'s receipt.'))
    },
  }).single('photo')
  return (req: any, res: any, next: any) => {
    upload(req, res, (err: any) => {
      if (!err) return next()
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError(400, `That photo is too large — the limit is ${Math.round(BANK_DEPOSIT_PHOTO_MAX_BYTES / (1024 * 1024))} MB.`))
      }
      if (err instanceof multer.MulterError) return next(new AppError(400, 'Send one photo of the bank\'s receipt.'))
      next(err)
    })
  }
}

/** The landlord's own people only: the owner and their team — never a GAM admin or a tenant. */
export function landlordsOwnUser(user: any, landlordId: string): boolean {
  if (!user || user.role === 'admin' || user.role === 'super_admin' || user.role === 'tenant') return false
  return canAccessLandlordResource(user, landlordId)
}
