// 10/5 (Nic) — photos of a bank's deposit receipt.
//
// Two kinds, one way of taking them: the landlord's photo on a payment they
// recorded as a bank deposit (routes/payments.ts), and the tenant's photo on
// their own "I paid at the bank" report (routes/declaredDeposits.ts). Images
// only, the same size cap, an unguessable file name, and each kind served by
// one authed route that authorizes per row — never a static URL.

import crypto from 'crypto'
import multer from 'multer'
import { BANK_DEPOSIT_PHOTO_TYPES, BANK_DEPOSIT_PHOTO_MAX_BYTES } from '@gam/shared'
import { AppError } from '../middleware/errorHandler'
import { canAccessLandlordResource } from '../middleware/scope'
import { storage } from './storage'

const PHOTO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif',
}

/**
 * Express middleware taking one photo (multipart field 'photo') into storage
 * under `<subdir>/`, with multer's own refusals said in plain words. A1: the
 * photo is held in memory, then saved through the storage driver; the handler
 * after it reads `req.file.filename` exactly as it did with disk storage.
 */
export function takeBankReceiptPhoto(subdir: string) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: BANK_DEPOSIT_PHOTO_MAX_BYTES, files: 1 },
    fileFilter: (_req: any, file: any, cb: any) => {
      if ((BANK_DEPOSIT_PHOTO_TYPES as readonly string[]).includes(file.mimetype)) cb(null, true)
      else cb(new AppError(400, 'Choose a photo (JPEG, PNG, WebP or HEIC) of the bank\'s receipt.'))
    },
  }).single('photo')
  return (req: any, res: any, next: any) => {
    upload(req, res, (err: any) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError(400, `That photo is too large — the limit is ${Math.round(BANK_DEPOSIT_PHOTO_MAX_BYTES / (1024 * 1024))} MB.`))
      }
      if (err instanceof multer.MulterError) return next(new AppError(400, 'Send one photo of the bank\'s receipt.'))
      if (err) return next(err)
      if (!req.file) return next()
      const filename = Date.now() + '-' + crypto.randomBytes(12).toString('hex') + (PHOTO_EXT[req.file.mimetype] ?? '.img')
      storage.save(`${subdir}/${filename}`, req.file.buffer)
        .then(() => { req.file.filename = filename; next() })
        .catch(next)
    })
  }
}

/** The landlord's own people only: the owner and their team — never a GAM admin or a tenant. */
export function landlordsOwnUser(user: any, landlordId: string): boolean {
  if (!user || user.role === 'admin' || user.role === 'super_admin' || user.role === 'tenant') return false
  return canAccessLandlordResource(user, landlordId)
}
