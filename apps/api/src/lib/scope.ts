// S633 — `resolveLandlordIdForUser` IS GONE. Do not bring it back.
//
// It answered "which ONE landlord does this request operate on?" by reading the
// single entity the session sat on. That question has no answer any more: an
// account owns entities, and asking which one it "is" is the bug this release
// exists to remove. Nic: "Account ownership is no correlation to a specific
// entity. Entities own properties. The account owns the entities."
//
// It was deleted rather than made to return null so that TypeScript names every
// call site instead of each one quietly scoping to nothing at runtime. Use:
//
//   READS  -> landlordScopeIds(user)              (lib/landlordScope)
//              ... WHERE landlord_id = ANY($n::uuid[])
//   WRITES -> resolveLandlordTarget / landlordIdForProperty
//
// Team roles ARE genuinely scoped to one landlord; landlordScopeIds returns
// their single id as a one-element array, so those call sites keep working
// unchanged with the array form.
