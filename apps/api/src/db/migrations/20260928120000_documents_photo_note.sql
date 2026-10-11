-- S652 (Nic): "maintenance people need to be able to add a picture to something
-- for record keeping… a way to upload a picture of said notice to that tenant's
-- profile… it can just go in their history with all their other documents."
-- A photo on a resident's record carries who took it, when it was posted, and a
-- line about it.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS note text,
  ADD COLUMN IF NOT EXISTS uploaded_by_user_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS posted_at date;
