// 10/11: the company picker moved into the shared financial pages
// (src/financials/EntityPicker.tsx), which the Reports page reads in both the
// landlord portal and GAM Books. Every landlord screen keeps importing it here.
export { useEntities, useCompanyMissing, EntityPicker, type EntityOption } from '../financials/EntityPicker'
