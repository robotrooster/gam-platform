-- S582: async auto-field placement jobs.
--
-- WHY: auto-placing e-sign boxes runs the in-house AI model, which is
-- variable-latency (~30s typical, longer on big leases). The request was
-- SYNCHRONOUS and runs behind the Cloudflare tunnel, whose edge kills any
-- request that hasn't responded within ~100s (fixed on non-Enterprise plans).
-- A slow model would 524 before the response — and the landlord would see an
-- error instead of a placed template. Nic's call: decouple it entirely — the
-- upload starts a JOB, the model box works with no time pressure, and the editor
-- polls for the result on a separate call. No request is ever held open, so
-- Cloudflare is out of the picture and the model can take its natural time
-- (better labels, never truncated).
--
-- Rows are transient work-tracking (not business records): a landlord kicks off
-- a placement, the editor polls until done, loads the fields. Kept for audit /
-- restart-visibility. No backfill needed (new table).

CREATE TABLE IF NOT EXISTS auto_field_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  uuid NOT NULL REFERENCES lease_templates(id) ON DELETE CASCADE,
  landlord_id  uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'processing'
               CHECK (status IN ('processing', 'done', 'error')),
  result       jsonb,          -- the AutoPlaceResult (pageCount, fields[], modelUsed) when done
  error        text,           -- message when status='error'
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auto_field_jobs_template
  ON auto_field_jobs (template_id, created_at DESC);
