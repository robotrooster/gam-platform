-- 10/29 (Nic): "We should get the picture of the front and the back. In case
-- the barcode is unreadable or only partially read or whatever, we can have
-- the parser pull the information off the front."
--
-- document_url holds ONE picture, and until now that was the back — the side
-- with the PDF417 barcode, because that is the side a machine can read. The
-- front is the side a PERSON reads, and it is also the copy a park wants on
-- file "in case something happens": a face, a name, an expiry, all legible
-- without any software at all.
--
-- So both sides are kept, and document_url keeps its meaning — the back, the
-- machine-readable one — so nothing that already reads it has to change. A
-- record may have either side, both, or (for an identification that came from
-- Checkr, where GAM never holds the image) neither.
--
-- Reading the front is OCR, a different engine from barcode decoding and a
-- markedly harder problem on a card with a hologram over the text. Nothing
-- here commits to it: the column is the picture, and whether anything ever
-- reads it automatically is a later decision. Storing it is worth doing on its
-- own.
--
-- No backfill needed: one identification exists, from Checkr, which holds no
-- image either way.

ALTER TABLE tenant_identifications
  ADD COLUMN IF NOT EXISTS document_front_url TEXT;

COMMENT ON COLUMN tenant_identifications.document_url IS
  '10/29: the BACK of the document — the side carrying the PDF417 barcode the server reads. NULL when the identification came from Checkr (they hold the image, GAM holds the fields) or the guest only sent a front.';
COMMENT ON COLUMN tenant_identifications.document_front_url IS
  '10/29: the FRONT — the side a person reads, and the copy a park keeps "in case something happens". Never machine-read today; stored because it is worth having on its own.';
