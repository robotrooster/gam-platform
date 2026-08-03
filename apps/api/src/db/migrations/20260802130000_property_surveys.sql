-- S577 — property-scoped tenant surveys (Nic).
--
-- WHY: a Google-Forms-style questionnaire a landlord builds and sends to the
-- tenants of ONE property to gather input before making a change (e.g. "which
-- weekend for the pool closure?"). This is NOT the removed bulletin board and
-- is NOT tenant-authored — the landlord authors, tenants answer.
--
-- HARD SCOPING RULE (Nic): every survey belongs to exactly one property and its
-- responses are NEVER mixed with another property's. Running "the same survey"
-- at a second property is a COPY (new survey row + questions, its own separate
-- responses) via POST /surveys/:id/copy — never a shared survey across props.
--
-- Question types are deliberately minimal (Nic): multiple_choice (pick one) and
-- text (free response). Enum mirrors shared SURVEY_QUESTION_TYPES / SURVEY_STATUSES.
--
-- Soft-delete via is_active (platform keep-everything rule). No backfill.

CREATE TABLE surveys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id   uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  property_id   uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  created_by    uuid REFERENCES users(id),
  title         text NOT NULL,
  description   text,
  status        text NOT NULL DEFAULT 'draft' CHECK (status = ANY (ARRAY['draft','sent','closed']::text[])),
  anonymous     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  closed_at     timestamptz,
  is_active     boolean NOT NULL DEFAULT true
);
CREATE INDEX idx_surveys_property ON surveys (property_id) WHERE is_active;
CREATE INDEX idx_surveys_landlord ON surveys (landlord_id) WHERE is_active;

CREATE TABLE survey_questions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id     uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  position      integer NOT NULL DEFAULT 0,
  question_type text NOT NULL CHECK (question_type = ANY (ARRAY['multiple_choice','text']::text[])),
  prompt        text NOT NULL,
  options       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- string[] of choices (multiple_choice only)
  required      boolean NOT NULL DEFAULT false
);
CREATE INDEX idx_survey_questions_survey ON survey_questions (survey_id);

CREATE TABLE survey_responses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id     uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (survey_id, tenant_id)                        -- one response per tenant per survey
);
CREATE INDEX idx_survey_responses_survey ON survey_responses (survey_id);

CREATE TABLE survey_answers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id   uuid NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE,
  question_id   uuid NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
  answer_text   text                                   -- free text, OR the chosen option string for multiple_choice
);
CREATE INDEX idx_survey_answers_response ON survey_answers (response_id);
CREATE INDEX idx_survey_answers_question ON survey_answers (question_id);
