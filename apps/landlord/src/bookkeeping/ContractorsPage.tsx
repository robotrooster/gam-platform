/**
 * 10/12 (Nic): "VENDORS = one list of everyone the company pays (contractors,
 * garbage company, power company) with a type; contractors get a 1099 box."
 * The Contractors page is folded into Vendors; its old address opens the
 * Vendors page on its Contractors tab, so a saved link still lands somewhere.
 *
 * Same bytes in apps/books and apps/landlord (bookkeeping-parity.test.ts).
 */
import { Navigate } from 'react-router-dom'
import { booksPath } from './adapter'

export function ContractorsPage(){
  return <Navigate to={`${booksPath('vendors')}?type=contractor`} replace/>
}
