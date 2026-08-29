import { queryOne } from '../db'

export interface LandlordSigner {
  userId: string
  firstName: string
  lastName: string
  name: string
  /** Where the signing link and lease notifications actually go. */
  email: string
  phone: string | null
  /** The account email, for anything that must reach the OWNER regardless. */
  accountEmail: string
  /** Set when this property routes elsewhere — i.e. somebody on site signs. */
  delegatedEmail: string | null
}

/**
 * Who signs for the landlord on THIS property, and where that reaches them.
 *
 * S630 (Nic): one portfolio login, but lease signing routed per property, so an
 * on-site manager can sign for that property without being handed the login or
 * the other properties' mail.
 *
 * The property override only applies when the property actually belongs to this
 * landlord entity — the join is constrained on landlord_id rather than trusting
 * a passed-in id, because this decides where a signable lease link is mailed.
 *
 * Delegating delivery is not the same as changing who the lease says signed it:
 * `name` stays the landlord's own unless the property names an on-site signer.
 */
export async function landlordSigningContact(
  landlordId: string,
  ref: { propertyId?: string | null; unitId?: string | null },
  client?: { query: Function },
): Promise<LandlordSigner | null> {
  const sql = `
    SELECT u.id AS user_id, u.first_name, u.last_name, u.phone,
           u.email AS account_email,
           p.lease_signing_email AS delegated_email,
           p.lease_signing_name  AS delegated_name
      FROM landlords l
      JOIN users u ON u.id = l.user_id
      LEFT JOIN properties p
        ON p.landlord_id = l.id
       AND p.id = COALESCE($2::uuid, (SELECT property_id FROM units WHERE id = $3::uuid))
     WHERE l.id = $1
     LIMIT 1`
  const params = [landlordId, ref.propertyId ?? null, ref.unitId ?? null]
  const row: any = client
    ? await client.query(sql, params).then((r: any) => r.rows[0])
    : await queryOne<any>(sql, params)
  if (!row) return null

  const ownName = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim()
  return {
    userId: row.user_id,
    firstName: row.first_name,
    lastName: row.last_name,
    name: row.delegated_name?.trim() || ownName,
    email: row.delegated_email || row.account_email,
    phone: row.phone ?? null,
    accountEmail: row.account_email,
    delegatedEmail: row.delegated_email ?? null,
  }
}
