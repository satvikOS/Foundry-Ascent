-- Foundry Ascent — initial schema.
--
-- Isolation model (ADR-004):
--   * Application requests run inside a transaction that switches to role app_rls (NOBYPASSRLS, not a
--     table owner) and sets app.principal_id / app.tenant_id. Every tenant- or venture-scoped table has
--     row level security enabled; policies call the SECURITY DEFINER helpers in schema app.
--   * The migration/owner role is reserved for migrations and trusted system jobs (credential
--     verification, audit chaining, workers processing server-generated jobs).
--   * Credential, ledger and audit tables grant nothing to app_rls.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
    CREATE ROLE app_rls NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;
GRANT app_rls TO CURRENT_USER;

CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO app_rls;
GRANT USAGE ON SCHEMA public TO app_rls;

-- array_to_string is STABLE in general; for text[] it is deterministic, which generated columns require.
CREATE FUNCTION app.text_array_join(p text[]) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT array_to_string(p, ' ') $$;

-- ---------------------------------------------------------------------------------------------------
-- Tenancy and identity
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('home', 'partner')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE principals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  email         text CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+$'),
  title         text,
  synthetic     boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX principals_tenant_idx ON principals (tenant_id);

CREATE TABLE role_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id  uuid NOT NULL REFERENCES principals (id),
  tenant_id     uuid REFERENCES tenants (id), -- NULL for platform-scoped roles
  role          text NOT NULL CHECK (role IN ('platform_admin', 'program_lead', 'eir')),
  granted_by    uuid REFERENCES principals (id),
  granted_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  CHECK ((role = 'platform_admin') = (tenant_id IS NULL))
);
CREATE UNIQUE INDEX role_grants_active_uq
  ON role_grants (principal_id, role, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE revoked_at IS NULL;

-- Access codes: FA-<prefix>-<secret>-<secret>-<secret>. The prefix (5 Crockford base32 chars) is a public
-- lookup key; only the scrypt hash of the full code is stored.
CREATE TABLE access_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id  uuid NOT NULL REFERENCES principals (id),
  code_prefix   text NOT NULL UNIQUE CHECK (code_prefix ~ '^[0-9A-HJKMNP-TV-Z]{5}$'),
  code_hash     text NOT NULL,
  label         text NOT NULL DEFAULT 'access code',
  created_by    uuid REFERENCES principals (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  revoked_at    timestamptz,
  last_used_at  timestamptz
);
CREATE INDEX access_codes_principal_idx ON access_codes (principal_id);

CREATE TABLE auth_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id  uuid NOT NULL REFERENCES principals (id),
  access_code_id uuid REFERENCES access_codes (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  user_agent_hash text
);
CREATE INDEX auth_sessions_principal_idx ON auth_sessions (principal_id);

CREATE TABLE auth_attempts (
  id            bigserial PRIMARY KEY,
  subject_hash  text NOT NULL, -- sha256(salted viewer IP) or 'global'
  succeeded     boolean NOT NULL,
  attempted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_attempts_subject_time_idx ON auth_attempts (subject_hash, attempted_at DESC);

CREATE TABLE platform_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose     text NOT NULL CHECK (purpose IN ('session_signing', 'ip_hash_salt')),
  key_bytes   bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  retired_at  timestamptz
);
CREATE UNIQUE INDEX platform_keys_active_uq ON platform_keys (purpose) WHERE retired_at IS NULL;
INSERT INTO platform_keys (purpose, key_bytes) VALUES
  ('session_signing', gen_random_bytes(32)),
  ('ip_hash_salt', gen_random_bytes(32));

CREATE TABLE platform_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES principals (id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_settings (key, value) VALUES
  ('ai_enabled', 'true'),
  ('daily_usd_cap_global', '2.00'),
  ('daily_usd_cap_per_principal', '0.50'),
  ('max_turns_per_session', '40'),
  ('grounding_coverage_threshold', '0.6'),
  ('portfolio_min_group_size', '3');

-- ---------------------------------------------------------------------------------------------------
-- Ventures, EIRs, personas, assignments
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE ventures (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  one_liner       text NOT NULL DEFAULT '',
  stage           text NOT NULL DEFAULT 'idea' CHECK (stage IN (
                    'idea', 'discovery', 'validation', 'business_model', 'commercialization', 'growth', 'transition')),
  domain          text NOT NULL DEFAULT 'general' CHECK (domain IN (
                    'consumer', 'software', 'hardware', 'biomedical', 'clinical', 'energy', 'social', 'general')),
  cohort          text,
  classification  text NOT NULL DEFAULT 'synthetic' CHECK (classification IN ('synthetic', 'public', 'venture_private')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'graduated', 'archived')),
  current_goal    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ventures_tenant_idx ON ventures (tenant_id);

CREATE TABLE venture_memberships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venture_id    uuid NOT NULL REFERENCES ventures (id),
  principal_id  uuid NOT NULL REFERENCES principals (id),
  role          text NOT NULL CHECK (role IN ('founder', 'team', 'advisor')),
  granted_by    uuid REFERENCES principals (id),
  granted_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  revoked_at    timestamptz
);
CREATE UNIQUE INDEX venture_memberships_active_uq ON venture_memberships (venture_id, principal_id) WHERE revoked_at IS NULL;
CREATE INDEX venture_memberships_principal_idx ON venture_memberships (principal_id);

CREATE TABLE eir_profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  principal_id    uuid REFERENCES principals (id),
  display_name    text NOT NULL,
  title           text,
  expertise_tags  text[] NOT NULL DEFAULT '{}',
  routing_intents text[] NOT NULL DEFAULT '{}',
  synthetic       boolean NOT NULL DEFAULT true,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'unavailable', 'retired')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX eir_profiles_tenant_idx ON eir_profiles (tenant_id);

CREATE TABLE consents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  subject_principal_id uuid NOT NULL REFERENCES principals (id),
  asset_types         text[] NOT NULL CHECK (asset_types <@ ARRAY['doctrine', 'style', 'voice', 'likeness', 'cases']::text[]),
  approved_uses       text[] NOT NULL DEFAULT '{}',
  audiences           text[] NOT NULL DEFAULT '{}',
  evidence_ref        text,
  granted_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz,
  revoked_at          timestamptz
);

CREATE TABLE personas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  eir_profile_id  uuid REFERENCES eir_profiles (id),
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('neutral_guide', 'eir_persona')),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'suspended', 'retired')),
  consent_id      uuid REFERENCES consents (id),
  suspended_reason text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- An EIR persona can never be active without a consent record (blueprint 02 §6).
  CHECK (kind = 'neutral_guide' OR status <> 'active' OR consent_id IS NOT NULL)
);

CREATE TABLE persona_releases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id      uuid NOT NULL REFERENCES personas (id),
  version         integer NOT NULL CHECK (version > 0),
  doctrine        jsonb NOT NULL,  -- frameworks, typical questions, evidence standard, red lines, referrals
  style           jsonb NOT NULL,  -- directness, warmth, pace, vocabulary, feedback structure, avoid
  disclosure_text text NOT NULL,
  allowed_modes   text[] NOT NULL DEFAULT ARRAY['diagnose', 'challenge', 'coach', 'teach', 'rehearse', 'route'],
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded', 'withdrawn')),
  created_by      uuid REFERENCES principals (id),
  approved_by     uuid REFERENCES principals (id),
  approved_at     timestamptz,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (persona_id, version),
  CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE assignments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  venture_id          uuid NOT NULL REFERENCES ventures (id),
  persona_id          uuid NOT NULL REFERENCES personas (id),
  eir_profile_id      uuid REFERENCES eir_profiles (id),
  allowed_modes       text[] NOT NULL DEFAULT ARRAY['diagnose', 'challenge', 'coach', 'teach', 'rehearse', 'route'],
  data_class_ceiling  text NOT NULL DEFAULT 'venture_private' CHECK (data_class_ceiling IN ('public', 'program_internal', 'venture_private')),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'ended')),
  starts_at           timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz,
  created_by          uuid REFERENCES principals (id),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX assignments_active_uq ON assignments (venture_id) WHERE status = 'active';

-- ---------------------------------------------------------------------------------------------------
-- Knowledge, documents, memory
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE knowledge_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  scope           text NOT NULL CHECK (scope IN ('public', 'program', 'persona', 'venture')),
  venture_id      uuid REFERENCES ventures (id),
  persona_id      uuid REFERENCES personas (id),
  title           text NOT NULL,
  uri             text,
  owner           text,
  classification  text NOT NULL DEFAULT 'synthetic' CHECK (classification IN ('synthetic', 'public', 'program_internal', 'venture_private')),
  checksum        text,
  license         text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'withdrawn')),
  freshness_at    timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES principals (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'venture') = (venture_id IS NOT NULL)),
  CHECK (scope <> 'persona' OR persona_id IS NOT NULL)
);
CREATE INDEX knowledge_sources_scope_idx ON knowledge_sources (tenant_id, scope);
CREATE INDEX knowledge_sources_venture_idx ON knowledge_sources (venture_id) WHERE venture_id IS NOT NULL;

CREATE TABLE knowledge_chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     uuid NOT NULL REFERENCES knowledge_sources (id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  scope         text NOT NULL CHECK (scope IN ('public', 'program', 'persona', 'venture')),
  venture_id    uuid REFERENCES ventures (id),
  persona_id    uuid REFERENCES personas (id),
  ordinal       integer NOT NULL,
  heading       text,
  content       text NOT NULL,
  token_count   integer NOT NULL DEFAULT 0,
  embedding     vector(1024),
  tsv           tsvector GENERATED ALWAYS AS (
                  to_tsvector('english', coalesce(heading, '') || ' ' || content)) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, ordinal),
  CHECK ((scope = 'venture') = (venture_id IS NOT NULL))
);
CREATE INDEX knowledge_chunks_venture_idx ON knowledge_chunks (venture_id) WHERE venture_id IS NOT NULL;
CREATE INDEX knowledge_chunks_scope_idx ON knowledge_chunks (tenant_id, scope);
CREATE INDEX knowledge_chunks_tsv_idx ON knowledge_chunks USING gin (tsv);
-- Shared (non-venture) corpora use ANN; venture-scoped retrieval filters by venture first and scans exactly.
CREATE INDEX knowledge_chunks_shared_embedding_idx ON knowledge_chunks
  USING hnsw (embedding vector_cosine_ops) WHERE venture_id IS NULL;

CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  venture_id    uuid NOT NULL REFERENCES ventures (id),
  filename      text NOT NULL,
  content_type  text NOT NULL CHECK (content_type IN (
                  'application/pdf', 'text/plain', 'text/markdown',
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  size_bytes    integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  s3_key        text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'pending_upload' CHECK (status IN (
                  'pending_upload', 'processing', 'ready', 'failed', 'deleted')),
  failure_reason text,
  source_id     uuid REFERENCES knowledge_sources (id),
  uploaded_by   uuid NOT NULL REFERENCES principals (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_venture_idx ON documents (venture_id);

CREATE TABLE memory_objects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  venture_id      uuid NOT NULL REFERENCES ventures (id),
  type            text NOT NULL CHECK (type IN (
                    'fact', 'hypothesis', 'decision', 'experiment', 'evidence', 'action',
                    'milestone', 'risk', 'preference', 'relationship', 'insight')),
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  content         text NOT NULL CHECK (length(content) <= 8000),
  attributes      jsonb NOT NULL DEFAULT '{}'::jsonb, -- type-specific: owner, target_date, prediction, result, rationale, reversal_condition…
  status          text NOT NULL DEFAULT 'proposed' CHECK (status IN (
                    'proposed', 'confirmed', 'disputed', 'superseded', 'expired', 'rejected', 'deleted')),
  visibility      text NOT NULL DEFAULT 'venture' CHECK (visibility IN ('founder_private', 'team', 'venture', 'advisors')),
  confidence      numeric(3, 2) NOT NULL DEFAULT 0.50 CHECK (confidence BETWEEN 0 AND 1),
  source_refs     jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{kind: session|turn|document|chunk|manual, id, span?}]
  origin          text NOT NULL CHECK (origin IN ('founder', 'ai', 'eir', 'import')),
  created_by      uuid NOT NULL REFERENCES principals (id),
  approved_by     uuid REFERENCES principals (id),
  approved_at     timestamptz,
  version         integer NOT NULL DEFAULT 1,
  supersedes_id   uuid REFERENCES memory_objects (id),
  pinned          boolean NOT NULL DEFAULT false,
  expires_at      timestamptz,
  embedding       vector(1024),
  tsv             tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || content)) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- No durable memory from an unverified model inference alone (blueprint 02 §5).
  CHECK (origin <> 'ai' OR status IN ('proposed', 'rejected', 'deleted') OR approved_by IS NOT NULL)
);
CREATE INDEX memory_objects_venture_idx ON memory_objects (venture_id, type, status);
CREATE INDEX memory_objects_tsv_idx ON memory_objects USING gin (tsv);

CREATE TABLE memory_events (
  id          bigserial PRIMARY KEY,
  memory_id   uuid NOT NULL REFERENCES memory_objects (id),
  venture_id  uuid NOT NULL REFERENCES ventures (id),
  actor_id    uuid NOT NULL REFERENCES principals (id),
  action      text NOT NULL CHECK (action IN (
                'proposed', 'created', 'approved', 'rejected', 'corrected', 'superseded', 'disputed',
                'pinned', 'unpinned', 'deleted', 'expired')),
  diff        jsonb NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_events_memory_idx ON memory_events (memory_id, at);

-- ---------------------------------------------------------------------------------------------------
-- Sessions, turns, evidence, feedback
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE coaching_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  venture_id          uuid NOT NULL REFERENCES ventures (id),
  assignment_id       uuid NOT NULL REFERENCES assignments (id),
  persona_release_id  uuid NOT NULL REFERENCES persona_releases (id),
  started_by          uuid NOT NULL REFERENCES principals (id),
  mode                text NOT NULL DEFAULT 'diagnose' CHECK (mode IN ('diagnose', 'challenge', 'coach', 'teach', 'rehearse', 'route')),
  privacy             text NOT NULL DEFAULT 'standard' CHECK (privacy IN ('standard', 'ephemeral')),
  goal                text,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'suspended')),
  policy_version      text NOT NULL,
  recap               jsonb,
  started_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz
);
CREATE INDEX coaching_sessions_venture_idx ON coaching_sessions (venture_id, started_at DESC);

CREATE TABLE turns (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  venture_id          uuid NOT NULL REFERENCES ventures (id),
  session_id          uuid NOT NULL REFERENCES coaching_sessions (id),
  ordinal             integer NOT NULL,
  author_id           uuid NOT NULL REFERENCES principals (id),
  mode                text NOT NULL,
  founder_text        text NOT NULL CHECK (length(founder_text) BETWEEN 1 AND 8000),
  response            jsonb,           -- validated CoachResponse
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'blocked', 'failed')),
  risk_label          text,
  risk_categories     text[] NOT NULL DEFAULT '{}',
  validator_results   jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_id            text,
  fallback_used       boolean NOT NULL DEFAULT false,
  input_tokens        integer NOT NULL DEFAULT 0,
  output_tokens       integer NOT NULL DEFAULT 0,
  cost_usd            numeric(10, 6) NOT NULL DEFAULT 0,
  latency_ms          integer,
  sampled_for_review  boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  UNIQUE (session_id, ordinal)
);
CREATE INDEX turns_venture_idx ON turns (venture_id, created_at DESC);

CREATE TABLE turn_evidence (
  turn_id       uuid NOT NULL REFERENCES turns (id) ON DELETE CASCADE,
  evidence_key  text NOT NULL,      -- E1..En as shown to the model and the founder
  venture_id    uuid REFERENCES ventures (id),
  kind          text NOT NULL CHECK (kind IN ('memory', 'chunk', 'doctrine', 'resource', 'pattern')),
  ref_id        uuid NOT NULL,
  score         real NOT NULL,
  title         text NOT NULL,
  PRIMARY KEY (turn_id, evidence_key)
);

CREATE TABLE feedback (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  turn_id       uuid NOT NULL REFERENCES turns (id),
  venture_id    uuid NOT NULL REFERENCES ventures (id),
  principal_id  uuid NOT NULL REFERENCES principals (id),
  rating        smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  flags         text[] NOT NULL DEFAULT '{}',
  comment       text CHECK (comment IS NULL OR length(comment) <= 2000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (turn_id, principal_id)
);

CREATE TABLE eir_reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  turn_id       uuid NOT NULL REFERENCES turns (id),
  venture_id    uuid NOT NULL REFERENCES ventures (id),
  reviewer_id   uuid NOT NULL REFERENCES principals (id),
  scores        jsonb NOT NULL, -- correctness, rigor, specificity, teachability, persona_fit, escalation (1–5)
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (turn_id, reviewer_id)
);

-- ---------------------------------------------------------------------------------------------------
-- Escalations, resources, patterns
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE escalations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id),
  venture_id            uuid NOT NULL REFERENCES ventures (id),
  session_id            uuid REFERENCES coaching_sessions (id),
  turn_id               uuid REFERENCES turns (id),
  category              text NOT NULL CHECK (category IN (
                          'security_identity', 'ip_licensing', 'legal', 'securities_investment',
                          'medical_regulatory', 'safety_wellbeing', 'conflict_harassment',
                          'expert_judgment', 'low_grounding', 'other')),
  priority              text NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  -- State machine (system design §6.2): draft | awaiting_consent → (founder consents) → awaiting_assignment
  -- (program routing queue) or routed (assigned EIR) → acknowledged → resolved | declined; any open state →
  -- withdrawn (founder).
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN (
                          'draft', 'awaiting_consent', 'awaiting_assignment', 'routed', 'acknowledged', 'resolved',
                          'declined', 'withdrawn')),
  requested_role        text NOT NULL DEFAULT 'eir' CHECK (requested_role IN ('eir', 'program_lead', 'specialist', 'university_support')),
  packet                jsonb NOT NULL, -- founder question, desired decision, shared facts, evidence, unknowns, reason, AI-generated label
  created_by            uuid NOT NULL REFERENCES principals (id),
  sharing_consent_at    timestamptz,
  sharing_consent_by    uuid REFERENCES principals (id),
  assignee_principal_id uuid REFERENCES principals (id),
  due_at                timestamptz,
  resolved_by           uuid REFERENCES principals (id),
  resolution            jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- The founder's sharing decision separates the pre-consent states from the shared ones.
  CONSTRAINT escalations_consent_state CHECK (
    (status IN ('draft', 'awaiting_consent') AND sharing_consent_at IS NULL)
    OR (status IN ('awaiting_assignment', 'routed', 'acknowledged', 'resolved') AND sharing_consent_at IS NOT NULL)
    OR status IN ('declined', 'withdrawn')),
  -- Waiting for routing means nobody is assigned; routed and acknowledged always have an assignee.
  CONSTRAINT escalations_assignee_state CHECK (
    (status <> 'awaiting_assignment' OR assignee_principal_id IS NULL)
    AND (status NOT IN ('routed', 'acknowledged') OR assignee_principal_id IS NOT NULL))
);
CREATE INDEX escalations_venture_idx ON escalations (venture_id, created_at DESC);
CREATE INDEX escalations_assignee_idx ON escalations (assignee_principal_id) WHERE assignee_principal_id IS NOT NULL;

CREATE TABLE resources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN (
                  'program', 'mentor_network', 'competition', 'funding', 'lab', 'commercialization',
                  'regulatory', 'legal_clinic', 'workshop', 'incubator', 'template', 'other')),
  description   text NOT NULL,
  url           text,
  tags          text[] NOT NULL DEFAULT '{}',
  stages        text[] NOT NULL DEFAULT '{}',
  eligibility   text,
  owner         text,
  freshness_at  timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'retired')),
  tsv           tsvector GENERATED ALWAYS AS (
                  to_tsvector('english', name || ' ' || description || ' ' || app.text_array_join(tags))) STORED,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX resources_tenant_idx ON resources (tenant_id);
CREATE INDEX resources_tsv_idx ON resources USING gin (tsv);

CREATE TABLE patterns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  title         text NOT NULL,
  context       text NOT NULL,
  signal        text NOT NULL,
  intervention  text NOT NULL,
  outcome       text NOT NULL,
  limits        text NOT NULL,
  source_class  text NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'published', 'withdrawn')),
  owner_id      uuid REFERENCES principals (id),
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------------
-- Ledgers: usage, audit, idempotency (no app_rls access)
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE usage_ledger (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid REFERENCES tenants (id),
  venture_id    uuid REFERENCES ventures (id),
  principal_id  uuid REFERENCES principals (id),
  purpose       text NOT NULL CHECK (purpose IN ('turn', 'recap', 'classification', 'embedding', 'ingestion', 'eval', 'seed')),
  model_id      text NOT NULL,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd      numeric(10, 6) NOT NULL DEFAULT 0,
  request_id    text,
  at            timestamptz NOT NULL DEFAULT now()
);
-- Daily caps query `at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`.
CREATE INDEX usage_ledger_time_idx ON usage_ledger (at DESC);
CREATE INDEX usage_ledger_principal_time_idx ON usage_ledger (principal_id, at DESC);

CREATE TABLE audit_events (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid,
  venture_id    uuid,
  actor_id      uuid,
  action        text NOT NULL,          -- e.g. session.started, retrieval.denied, persona.suspended
  object_type   text,
  object_id     text,
  outcome       text NOT NULL CHECK (outcome IN ('allowed', 'denied', 'succeeded', 'failed', 'blocked')),
  policy_reason text,
  request_id    text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb, -- identifiers and counts only, never content
  at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  prev_hash     text NOT NULL,
  hash          text NOT NULL
);
CREATE INDEX audit_events_tenant_time_idx ON audit_events (tenant_id, at DESC);
CREATE INDEX audit_events_action_idx ON audit_events (action, at DESC);

CREATE TABLE idempotency_keys (
  key           text NOT NULL,
  principal_id  uuid NOT NULL,
  route         text NOT NULL,
  response      jsonb NOT NULL,
  status_code   integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, route, key)
);

-- ---------------------------------------------------------------------------------------------------
-- Request-context helpers (SECURITY DEFINER: evaluated with owner rights so policies never recurse)
-- ---------------------------------------------------------------------------------------------------

CREATE FUNCTION app.current_principal() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.principal_id', true), '')::uuid $$;

CREATE FUNCTION app.current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app.has_role(p_role text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM role_grants g
    WHERE g.principal_id = app.current_principal()
      AND g.role = p_role
      AND g.revoked_at IS NULL
      AND (g.tenant_id IS NULL OR g.tenant_id = app.current_tenant()))
$$;

CREATE FUNCTION app.venture_role(p_venture uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.role FROM venture_memberships m
  JOIN ventures v ON v.id = m.venture_id
  WHERE m.venture_id = p_venture
    AND m.principal_id = app.current_principal()
    AND v.tenant_id = app.current_tenant()
    AND m.revoked_at IS NULL
    AND (m.expires_at IS NULL OR m.expires_at > now())
  LIMIT 1
$$;

CREATE FUNCTION app.is_assigned_eir(p_venture uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM assignments a
    JOIN eir_profiles e ON e.id = a.eir_profile_id
    WHERE a.venture_id = p_venture
      AND a.tenant_id = app.current_tenant()
      AND a.status = 'active'
      AND (a.expires_at IS NULL OR a.expires_at > now())
      AND e.principal_id = app.current_principal())
$$;

CREATE FUNCTION app.can_read_venture(p_venture uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app.venture_role(p_venture) IS NOT NULL OR app.is_assigned_eir(p_venture)
$$;

CREATE FUNCTION app.can_write_venture(p_venture uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app.venture_role(p_venture) IN ('founder', 'team')
$$;

CREATE FUNCTION app.can_see_item(p_venture uuid, p_visibility text, p_created_by uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE p_visibility
    WHEN 'founder_private' THEN p_created_by = app.current_principal() AND app.can_write_venture(p_venture)
    WHEN 'team'            THEN app.can_write_venture(p_venture)
    ELSE                        app.can_read_venture(p_venture)
  END
$$;

CREATE FUNCTION app.in_current_tenant(p_tenant uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT p_tenant = app.current_tenant() $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_rls;

-- ---------------------------------------------------------------------------------------------------
-- Audit chaining (owner-only writer; tamper-evident sha256 chain)
-- ---------------------------------------------------------------------------------------------------

CREATE FUNCTION app.append_audit(
  p_tenant uuid, p_venture uuid, p_actor uuid, p_action text, p_object_type text, p_object_id text,
  p_outcome text, p_policy_reason text, p_request_id text, p_metadata jsonb
) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_prev text;
  v_at   timestamptz := clock_timestamp();
  v_hash text;
  v_id   bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(7012026);
  SELECT hash INTO v_prev FROM audit_events ORDER BY id DESC LIMIT 1;
  v_prev := coalesce(v_prev, repeat('0', 64));
  v_hash := encode(digest(concat_ws('|', v_prev, p_tenant, p_venture, p_actor, p_action, p_object_type,
                                    p_object_id, p_outcome, p_policy_reason, p_request_id,
                                    coalesce(p_metadata, '{}'::jsonb)::text, v_at), 'sha256'), 'hex');
  INSERT INTO audit_events (tenant_id, venture_id, actor_id, action, object_type, object_id, outcome,
                            policy_reason, request_id, metadata, at, prev_hash, hash)
  VALUES (p_tenant, p_venture, p_actor, p_action, p_object_type, p_object_id, p_outcome,
          p_policy_reason, p_request_id, coalesce(p_metadata, '{}'::jsonb), v_at, v_prev, v_hash)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
-- Application requests may append (actor/tenant are taken from the request context) but never read.
CREATE FUNCTION app.audit(
  p_action text, p_object_type text, p_object_id text, p_outcome text, p_policy_reason text,
  p_venture uuid, p_metadata jsonb
) RETURNS bigint
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app.append_audit(app.current_tenant(), p_venture, app.current_principal(), p_action, p_object_type,
                          p_object_id, p_outcome, p_policy_reason,
                          nullif(current_setting('app.request_id', true), ''), p_metadata)
$$;
REVOKE ALL ON FUNCTION app.append_audit(uuid, uuid, uuid, text, text, text, text, text, text, jsonb) FROM PUBLIC, app_rls;
GRANT EXECUTE ON FUNCTION app.audit(text, text, text, text, text, uuid, jsonb) TO app_rls;

-- ---------------------------------------------------------------------------------------------------
-- Program portfolio aggregates (k-anonymous; no raw text)
-- ---------------------------------------------------------------------------------------------------

CREATE FUNCTION app.portfolio_summary() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  k integer := (SELECT (value #>> '{}')::integer FROM platform_settings WHERE key = 'portfolio_min_group_size');
  t uuid := app.current_tenant();
BEGIN
  IF NOT (app.has_role('program_lead') OR app.has_role('platform_admin')) THEN
    RAISE EXCEPTION 'portfolio access requires program_lead' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'min_group_size', k,
    'ventures_by_stage', (
      SELECT coalesce(jsonb_object_agg(stage, CASE WHEN n >= k THEN n ELSE NULL END), '{}'::jsonb)
      FROM (SELECT stage, count(*) AS n FROM ventures WHERE tenant_id = t AND status = 'active' GROUP BY stage) s),
    'escalations_by_category', (
      SELECT coalesce(jsonb_object_agg(category, CASE WHEN n >= k THEN n ELSE NULL END), '{}'::jsonb)
      FROM (SELECT category, count(DISTINCT venture_id) AS n FROM escalations
            WHERE tenant_id = t AND created_at > now() - interval '90 days' GROUP BY category) e),
    'open_escalations_by_priority', (
      SELECT coalesce(jsonb_object_agg(priority, n), '{}'::jsonb)
      FROM (SELECT priority, count(*) AS n FROM escalations
            WHERE tenant_id = t AND status IN ('awaiting_consent', 'awaiting_assignment', 'routed', 'acknowledged')
            GROUP BY priority) p),
    'active_ventures_30d', (
      SELECT count(DISTINCT venture_id) FROM coaching_sessions WHERE tenant_id = t AND started_at > now() - interval '30 days'),
    'sessions_30d', (
      SELECT count(*) FROM coaching_sessions WHERE tenant_id = t AND started_at > now() - interval '30 days'),
    'confirmed_decisions_30d', (
      SELECT count(*) FROM memory_objects WHERE tenant_id = t AND type = 'decision' AND status = 'confirmed'
        AND approved_at > now() - interval '30 days'),
    'experiments_completed_30d', (
      SELECT count(*) FROM memory_objects WHERE tenant_id = t AND type = 'experiment'
        AND attributes ->> 'status' = 'completed' AND updated_at > now() - interval '30 days'),
    'median_feedback_rating_30d', (
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY f.rating)
      FROM feedback f JOIN ventures v ON v.id = f.venture_id
      WHERE v.tenant_id = t AND f.created_at > now() - interval '30 days'
      HAVING count(DISTINCT f.venture_id) >= k)
  );
END
$$;
GRANT EXECUTE ON FUNCTION app.portfolio_summary() TO app_rls;

-- Escalation queue for program leads: metadata only unless the founder consented to sharing.
CREATE FUNCTION app.escalation_queue() RETURNS TABLE (
  id uuid, venture_id uuid, venture_name text, category text, priority text, status text,
  requested_role text, assignee_principal_id uuid, due_at timestamptz, created_at timestamptz, shared boolean
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (app.has_role('program_lead') OR app.has_role('platform_admin')) THEN
    RAISE EXCEPTION 'queue access requires program_lead' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT e.id, e.venture_id, v.name, e.category, e.priority, e.status, e.requested_role,
           e.assignee_principal_id, e.due_at, e.created_at, e.sharing_consent_at IS NOT NULL
    FROM escalations e JOIN ventures v ON v.id = e.venture_id
    WHERE e.tenant_id = app.current_tenant() AND e.status NOT IN ('draft', 'withdrawn')
    ORDER BY e.priority, e.created_at;
END
$$;
GRANT EXECUTE ON FUNCTION app.escalation_queue() TO app_rls;

-- ---------------------------------------------------------------------------------------------------
-- Privileges and row level security
-- ---------------------------------------------------------------------------------------------------

GRANT SELECT ON tenants, principals, role_grants, ventures, venture_memberships, eir_profiles, consents,
  personas, persona_releases, assignments, knowledge_sources, knowledge_chunks, documents, memory_objects,
  memory_events, coaching_sessions, turns, turn_evidence, feedback, eir_reviews, escalations, resources,
  patterns, platform_settings TO app_rls;
GRANT INSERT, UPDATE ON principals, role_grants, ventures, venture_memberships, eir_profiles, consents,
  personas, persona_releases, assignments, knowledge_sources, documents, memory_objects, coaching_sessions,
  turns, escalations, resources, patterns TO app_rls;
GRANT INSERT ON knowledge_chunks, memory_events, turn_evidence, feedback, eir_reviews TO app_rls;
GRANT UPDATE ON feedback, eir_reviews TO app_rls;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_rls;
-- access_codes, auth_sessions, auth_attempts, platform_keys, usage_ledger, audit_events, idempotency_keys:
-- no privileges for app_rls (system executor only).

ALTER TABLE tenants             ENABLE ROW LEVEL SECURITY;
ALTER TABLE principals          ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_grants         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ventures            ENABLE ROW LEVEL SECURITY;
ALTER TABLE venture_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE eir_profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE consents            ENABLE ROW LEVEL SECURITY;
ALTER TABLE personas            ENABLE ROW LEVEL SECURITY;
ALTER TABLE persona_releases    ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_sources   ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_objects      ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE coaching_sessions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE turns               ENABLE ROW LEVEL SECURITY;
ALTER TABLE turn_evidence       ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback            ENABLE ROW LEVEL SECURITY;
ALTER TABLE eir_reviews         ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources           ENABLE ROW LEVEL SECURITY;
ALTER TABLE patterns            ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_settings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_codes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_attempts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_keys       ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_ledger        ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys    ENABLE ROW LEVEL SECURITY;

-- Tenant-wide reference data -------------------------------------------------------------------------
CREATE POLICY tenants_read ON tenants FOR SELECT TO app_rls USING (id = app.current_tenant());

CREATE POLICY principals_read ON principals FOR SELECT TO app_rls USING (app.in_current_tenant(tenant_id));
CREATE POLICY principals_write ON principals FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND (app.has_role('program_lead') OR app.has_role('platform_admin')));
CREATE POLICY principals_update ON principals FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND (id = app.current_principal() OR app.has_role('program_lead') OR app.has_role('platform_admin')))
  WITH CHECK (app.in_current_tenant(tenant_id));

CREATE POLICY role_grants_read ON role_grants FOR SELECT TO app_rls
  USING (principal_id = app.current_principal() OR app.has_role('platform_admin')
         OR (app.has_role('program_lead') AND app.in_current_tenant(tenant_id)));
CREATE POLICY role_grants_insert ON role_grants FOR INSERT TO app_rls
  WITH CHECK (app.has_role('platform_admin') OR (app.has_role('program_lead') AND app.in_current_tenant(tenant_id) AND role = 'eir'));
CREATE POLICY role_grants_update ON role_grants FOR UPDATE TO app_rls
  USING (app.has_role('platform_admin') OR (app.has_role('program_lead') AND app.in_current_tenant(tenant_id) AND role = 'eir'));

CREATE POLICY platform_settings_read ON platform_settings FOR SELECT TO app_rls USING (app.current_principal() IS NOT NULL);

-- Ventures and memberships ----------------------------------------------------------------------------
CREATE POLICY ventures_read ON ventures FOR SELECT TO app_rls
  USING (app.in_current_tenant(tenant_id) AND (app.can_read_venture(id) OR app.has_role('program_lead')));
CREATE POLICY ventures_insert ON ventures FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND app.has_role('program_lead'));
CREATE POLICY ventures_update ON ventures FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND (app.can_write_venture(id) OR app.has_role('program_lead')))
  WITH CHECK (app.in_current_tenant(tenant_id));

CREATE POLICY memberships_read ON venture_memberships FOR SELECT TO app_rls
  USING (app.can_read_venture(venture_id) OR principal_id = app.current_principal()
         OR (app.has_role('program_lead') AND EXISTS (SELECT 1 FROM ventures v WHERE v.id = venture_id AND app.in_current_tenant(v.tenant_id))));
CREATE POLICY memberships_insert ON venture_memberships FOR INSERT TO app_rls
  WITH CHECK (app.has_role('program_lead') AND EXISTS (SELECT 1 FROM ventures v WHERE v.id = venture_id AND app.in_current_tenant(v.tenant_id)));
CREATE POLICY memberships_update ON venture_memberships FOR UPDATE TO app_rls
  USING (app.has_role('program_lead') AND EXISTS (SELECT 1 FROM ventures v WHERE v.id = venture_id AND app.in_current_tenant(v.tenant_id)));

-- EIR registry, personas, consents, assignments ------------------------------------------------------
CREATE POLICY eir_profiles_read ON eir_profiles FOR SELECT TO app_rls USING (app.in_current_tenant(tenant_id));
CREATE POLICY eir_profiles_write ON eir_profiles FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND app.has_role('program_lead'));
CREATE POLICY eir_profiles_update ON eir_profiles FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND (app.has_role('program_lead') OR principal_id = app.current_principal()));

CREATE POLICY consents_read ON consents FOR SELECT TO app_rls
  USING (app.in_current_tenant(tenant_id) AND (subject_principal_id = app.current_principal() OR app.has_role('program_lead')));
CREATE POLICY consents_write ON consents FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND subject_principal_id = app.current_principal());
CREATE POLICY consents_update ON consents FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND subject_principal_id = app.current_principal());

CREATE POLICY personas_read ON personas FOR SELECT TO app_rls USING (app.in_current_tenant(tenant_id));
CREATE POLICY personas_insert ON personas FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND app.has_role('program_lead'));
CREATE POLICY personas_update ON personas FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND (app.has_role('program_lead') OR EXISTS (
    SELECT 1 FROM eir_profiles e WHERE e.id = eir_profile_id AND e.principal_id = app.current_principal())));

CREATE POLICY persona_releases_read ON persona_releases FOR SELECT TO app_rls
  USING (EXISTS (SELECT 1 FROM personas p WHERE p.id = persona_id AND app.in_current_tenant(p.tenant_id)));
CREATE POLICY persona_releases_insert ON persona_releases FOR INSERT TO app_rls
  WITH CHECK (EXISTS (SELECT 1 FROM personas p WHERE p.id = persona_id AND app.in_current_tenant(p.tenant_id)
    AND (app.has_role('program_lead') OR EXISTS (
      SELECT 1 FROM eir_profiles e WHERE e.id = p.eir_profile_id AND e.principal_id = app.current_principal()))));
CREATE POLICY persona_releases_update ON persona_releases FOR UPDATE TO app_rls
  USING (EXISTS (SELECT 1 FROM personas p WHERE p.id = persona_id AND app.in_current_tenant(p.tenant_id)
    AND (app.has_role('program_lead') OR EXISTS (
      SELECT 1 FROM eir_profiles e WHERE e.id = p.eir_profile_id AND e.principal_id = app.current_principal()))));

CREATE POLICY assignments_read ON assignments FOR SELECT TO app_rls
  USING (app.in_current_tenant(tenant_id) AND (app.can_read_venture(venture_id) OR app.has_role('program_lead')));
CREATE POLICY assignments_insert ON assignments FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND app.has_role('program_lead'));
CREATE POLICY assignments_update ON assignments FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND app.has_role('program_lead'));

-- Knowledge -------------------------------------------------------------------------------------------
CREATE POLICY knowledge_sources_read ON knowledge_sources FOR SELECT TO app_rls
  USING (app.in_current_tenant(tenant_id) AND (scope <> 'venture' OR app.can_read_venture(venture_id)));
CREATE POLICY knowledge_sources_insert ON knowledge_sources FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND CASE scope
    WHEN 'venture' THEN app.can_write_venture(venture_id)
    ELSE app.has_role('program_lead') OR app.has_role('eir') END);
CREATE POLICY knowledge_sources_update ON knowledge_sources FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND CASE scope
    WHEN 'venture' THEN app.can_write_venture(venture_id)
    ELSE app.has_role('program_lead') END);

CREATE POLICY knowledge_chunks_read ON knowledge_chunks FOR SELECT TO app_rls
  USING (app.in_current_tenant(tenant_id) AND (scope <> 'venture' OR app.can_read_venture(venture_id)));
CREATE POLICY knowledge_chunks_insert ON knowledge_chunks FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND (scope <> 'venture' OR app.can_write_venture(venture_id)));

CREATE POLICY documents_read ON documents FOR SELECT TO app_rls
  USING (app.in_current_tenant(tenant_id) AND app.can_read_venture(venture_id) AND status <> 'deleted');
CREATE POLICY documents_insert ON documents FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND app.can_write_venture(venture_id) AND uploaded_by = app.current_principal());
CREATE POLICY documents_update ON documents FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND app.can_write_venture(venture_id));

-- Memory ----------------------------------------------------------------------------------------------
CREATE POLICY memory_read ON memory_objects FOR SELECT TO app_rls
  USING (app.in_current_tenant(tenant_id) AND status <> 'deleted'
         AND app.can_see_item(venture_id, visibility, created_by));
CREATE POLICY memory_insert ON memory_objects FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND created_by = app.current_principal()
              AND (app.can_write_venture(venture_id) OR (origin = 'eir' AND app.is_assigned_eir(venture_id) AND status = 'proposed')));
CREATE POLICY memory_update ON memory_objects FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND app.can_write_venture(venture_id)
         AND app.can_see_item(venture_id, visibility, created_by))
  WITH CHECK (app.in_current_tenant(tenant_id) AND app.can_write_venture(venture_id));

CREATE POLICY memory_events_read ON memory_events FOR SELECT TO app_rls USING (app.can_read_venture(venture_id)
  AND EXISTS (SELECT 1 FROM memory_objects m WHERE m.id = memory_id));
CREATE POLICY memory_events_insert ON memory_events FOR INSERT TO app_rls
  WITH CHECK (actor_id = app.current_principal() AND (app.can_write_venture(venture_id) OR app.is_assigned_eir(venture_id)));

-- Sessions and turns: participants (founder/team) and, for sampled turns, the assigned EIR -------------
CREATE POLICY sessions_read ON coaching_sessions FOR SELECT TO app_rls
  USING (app.in_current_tenant(tenant_id) AND (app.can_write_venture(venture_id) OR app.is_assigned_eir(venture_id)));
CREATE POLICY sessions_insert ON coaching_sessions FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND app.can_write_venture(venture_id) AND started_by = app.current_principal());
CREATE POLICY sessions_update ON coaching_sessions FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND app.can_write_venture(venture_id));

CREATE POLICY turns_read ON turns FOR SELECT TO app_rls
  USING (app.in_current_tenant(tenant_id) AND (app.can_write_venture(venture_id)
         OR (sampled_for_review AND app.is_assigned_eir(venture_id))));
CREATE POLICY turns_insert ON turns FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND app.can_write_venture(venture_id) AND author_id = app.current_principal());
CREATE POLICY turns_update ON turns FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND app.can_write_venture(venture_id));

CREATE POLICY turn_evidence_read ON turn_evidence FOR SELECT TO app_rls
  USING (EXISTS (SELECT 1 FROM turns t WHERE t.id = turn_id));
CREATE POLICY turn_evidence_insert ON turn_evidence FOR INSERT TO app_rls
  WITH CHECK (EXISTS (SELECT 1 FROM turns t WHERE t.id = turn_id AND app.can_write_venture(t.venture_id)));

CREATE POLICY feedback_read ON feedback FOR SELECT TO app_rls USING (app.can_write_venture(venture_id));
CREATE POLICY feedback_insert ON feedback FOR INSERT TO app_rls
  WITH CHECK (principal_id = app.current_principal() AND app.can_write_venture(venture_id));
CREATE POLICY feedback_update ON feedback FOR UPDATE TO app_rls USING (principal_id = app.current_principal());

CREATE POLICY eir_reviews_read ON eir_reviews FOR SELECT TO app_rls
  USING (reviewer_id = app.current_principal() OR app.has_role('program_lead'));
CREATE POLICY eir_reviews_insert ON eir_reviews FOR INSERT TO app_rls
  WITH CHECK (reviewer_id = app.current_principal() AND app.is_assigned_eir(venture_id));
CREATE POLICY eir_reviews_update ON eir_reviews FOR UPDATE TO app_rls USING (reviewer_id = app.current_principal());

-- Escalations: founders/team; assignee only after the founder consented to sharing ------------------
CREATE POLICY escalations_read ON escalations FOR SELECT TO app_rls
  USING (app.in_current_tenant(tenant_id) AND (app.can_write_venture(venture_id)
         OR (assignee_principal_id = app.current_principal() AND sharing_consent_at IS NOT NULL)));
CREATE POLICY escalations_insert ON escalations FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND app.can_write_venture(venture_id) AND created_by = app.current_principal());
CREATE POLICY escalations_update ON escalations FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND (app.can_write_venture(venture_id)
         OR (assignee_principal_id = app.current_principal() AND sharing_consent_at IS NOT NULL)
         OR app.has_role('program_lead')));

-- Resources and patterns ------------------------------------------------------------------------------
CREATE POLICY resources_read ON resources FOR SELECT TO app_rls USING (app.in_current_tenant(tenant_id));
CREATE POLICY resources_insert ON resources FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND app.has_role('program_lead'));
CREATE POLICY resources_update ON resources FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND app.has_role('program_lead'));

CREATE POLICY patterns_read ON patterns FOR SELECT TO app_rls
  USING (app.in_current_tenant(tenant_id) AND (status = 'published' OR app.has_role('program_lead')));
CREATE POLICY patterns_insert ON patterns FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND app.has_role('program_lead'));
CREATE POLICY patterns_update ON patterns FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND app.has_role('program_lead'));
