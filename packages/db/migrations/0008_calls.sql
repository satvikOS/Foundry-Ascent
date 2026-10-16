-- Foundry Ascent — vEIR voice calls (docs/architecture/calls.md §2).
-- Applied on top of 0001–0007; expand-only: nothing an older build reads changes shape, and every statement is
-- re-runnable (IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS before CREATE, ON CONFLICT DO NOTHING).
--
--  1. calls: one row per voice call of a conversation. A call is a mode of a conversation: its words are the
--     conversation's turns. The row holds numbers and identifiers only (who, when, how long, why it ended,
--     client latency stats), never content. One live call per person (partial unique index). The identity,
--     limits and start of a call never change, and an ended call stays ended (trigger).
--     Visible to the person who started it, the venture's founders and team (summaries), and the venture's
--     assigned EIR (like the conversation itself); written only by the person who started it.
--  2. Turns: the call a turn belongs to (a turn a person sends in a conversation while their call there is live
--     joins that call), and barge-in: the last speech unit the founder heard before interrupting and its words,
--     which are redacted with the turn's other content.
--  3. Settings: the `calls_enabled` kill switch (on; the AI kill switch still stops calls).
--  4. Spend caps: a person's daily AI spend cap leaves out speech (Polly and Transcribe during calls), which the
--     call-minute caps and the call speech budgets (5.) bound instead; the platform's daily cap still counts
--     everything.
--  5. Speech of a call: each thing a call had synthesized and how often, reserved before synthesis together
--     with the call's character budget, so nothing is replayed without limit (owner role only).
--
-- Call minutes are measured from this table (per call, and per person per UTC day): a live call counts until
-- now, or until shortly after its last heartbeat when the client went away (the time it is closed at).

-- ---------------------------------------------------------------------------------------------------
-- 1. Calls
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS calls (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  venture_id         uuid NOT NULL REFERENCES ventures (id),
  session_id         uuid NOT NULL REFERENCES coaching_sessions (id),
  persona_id         uuid NOT NULL REFERENCES personas (id),
  started_by         uuid NOT NULL REFERENCES principals (id),
  status             text NOT NULL DEFAULT 'live',
  provider           text NOT NULL DEFAULT 'builtin',
  input_mode         text NOT NULL DEFAULT 'transcribe',
  -- The text-to-speech voice of the call (a stock voice, or the persona's own under voice consent).
  voice_id           text NOT NULL,
  -- Hard limit: the smaller of the per-call cap and the person's remaining minutes today, at the start.
  max_seconds        integer NOT NULL,
  started_at         timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at  timestamptz,
  ended_at           timestamptz,
  end_reason         text,
  -- Machine-readable detail of the end (kill_switch, calls_disabled, max_duration, stale_heartbeat, …).
  end_detail         text,
  -- What the client reported in its last heartbeat (state name and seconds the microphone was open).
  last_state         text,
  mic_open_seconds   integer NOT NULL DEFAULT 0,
  -- Speech-to-text grants minted and characters synthesized for this call.
  stt_grants         integer NOT NULL DEFAULT 0,
  speech_characters  integer NOT NULL DEFAULT 0,
  -- Client latency and resilience stats reported at the end (numbers only).
  first_audio_ms_p50 integer,
  first_audio_ms_p95 integer,
  barge_ins          integer,
  reconnects         integer,
  CONSTRAINT calls_status_check CHECK (status IN ('live', 'ended')),
  CONSTRAINT calls_provider_check CHECK (provider IN ('builtin', 'heygen', 'tavus', 'simli')),
  CONSTRAINT calls_input_mode_check CHECK (input_mode IN ('transcribe', 'typed')),
  CONSTRAINT calls_voice_check CHECK (length(voice_id) BETWEEN 1 AND 64),
  CONSTRAINT calls_max_seconds_check CHECK (max_seconds BETWEEN 0 AND 14400),
  CONSTRAINT calls_end_reason_check
    CHECK (end_reason IS NULL OR end_reason IN ('user', 'timeout', 'budget', 'disabled', 'error', 'navigated')),
  CONSTRAINT calls_end_detail_check CHECK (end_detail IS NULL OR end_detail ~ '^[a-z][a-z_]{0,39}$'),
  CONSTRAINT calls_state_check CHECK (
    (status = 'live' AND ended_at IS NULL AND end_reason IS NULL)
    OR (status = 'ended' AND ended_at IS NOT NULL AND end_reason IS NOT NULL AND ended_at >= started_at)),
  CONSTRAINT calls_last_state_check CHECK (
    last_state IS NULL OR last_state IN ('listening', 'thinking', 'speaking', 'idle', 'muted', 'reconnecting')),
  CONSTRAINT calls_counters_check CHECK (
    mic_open_seconds BETWEEN 0 AND 86400 AND stt_grants >= 0 AND speech_characters >= 0
    AND (first_audio_ms_p50 IS NULL OR first_audio_ms_p50 BETWEEN 0 AND 120000)
    AND (first_audio_ms_p95 IS NULL OR first_audio_ms_p95 BETWEEN 0 AND 120000)
    AND (barge_ins IS NULL OR barge_ins BETWEEN 0 AND 10000)
    AND (reconnects IS NULL OR reconnects BETWEEN 0 AND 10000))
);

-- One live call per person, whatever the conversation.
CREATE UNIQUE INDEX IF NOT EXISTS calls_one_live_per_person ON calls (started_by) WHERE status = 'live';
-- A conversation's calls, latest first.
CREATE INDEX IF NOT EXISTS calls_session_idx ON calls (session_id, started_at DESC);
-- Call minutes of a person today.
CREATE INDEX IF NOT EXISTS calls_starter_started_idx ON calls (started_by, started_at);
-- Live calls by heartbeat (reaping calls whose client went away).
CREATE INDEX IF NOT EXISTS calls_live_heartbeat_idx ON calls (last_heartbeat_at) WHERE status = 'live';

-- A call's identity, limits and start never change; an ended call stays ended. Ending a call stamps its end
-- time unless the caller gives one (a call reaped after its client went away ends at its last heartbeat).
CREATE OR REPLACE FUNCTION app.calls_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.venture_id <> OLD.venture_id
     OR NEW.session_id <> OLD.session_id OR NEW.persona_id <> OLD.persona_id OR NEW.started_by <> OLD.started_by
     OR NEW.provider <> OLD.provider OR NEW.voice_id <> OLD.voice_id OR NEW.max_seconds <> OLD.max_seconds
     OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'a call''s identity, limits and start never change' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'ended' AND (NEW.status <> 'ended' OR NEW.ended_at IS DISTINCT FROM OLD.ended_at
                               OR NEW.end_reason IS DISTINCT FROM OLD.end_reason
                               OR NEW.end_detail IS DISTINCT FROM OLD.end_detail) THEN
    RAISE EXCEPTION 'an ended call stays ended' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'live' AND NEW.status = 'ended' AND NEW.ended_at IS NULL THEN
    NEW.ended_at := greatest(now(), NEW.started_at);
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.calls_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS calls_guard ON calls;
CREATE TRIGGER calls_guard BEFORE UPDATE ON calls FOR EACH ROW EXECUTE FUNCTION app.calls_guard();

GRANT SELECT, INSERT, UPDATE ON calls TO app_rls;
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS calls_read ON calls;
CREATE POLICY calls_read ON calls FOR SELECT TO app_rls
  USING (app.in_current_tenant(tenant_id)
         AND (started_by = app.current_principal() OR app.can_write_venture(venture_id)
              OR app.is_assigned_eir(venture_id)));
-- A founder or team member starts a call on an active conversation of their venture, as themselves.
DROP POLICY IF EXISTS calls_insert ON calls;
CREATE POLICY calls_insert ON calls FOR INSERT TO app_rls
  WITH CHECK (app.in_current_tenant(tenant_id) AND started_by = app.current_principal()
              AND app.can_write_venture(venture_id)
              AND EXISTS (SELECT 1 FROM coaching_sessions s
                          WHERE s.id = calls.session_id AND s.venture_id = calls.venture_id
                            AND s.tenant_id = calls.tenant_id AND s.status = 'active' AND s.deleted_at IS NULL));
DROP POLICY IF EXISTS calls_update ON calls;
CREATE POLICY calls_update ON calls FOR UPDATE TO app_rls
  USING (app.in_current_tenant(tenant_id) AND started_by = app.current_principal())
  WITH CHECK (app.in_current_tenant(tenant_id) AND started_by = app.current_principal());

-- ---------------------------------------------------------------------------------------------------
-- 2. Turns: the call they belong to, and what the founder heard
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE turns ADD COLUMN IF NOT EXISTS call_id uuid REFERENCES calls (id);
-- Barge-in: the last speech unit (seq) the founder heard before speaking over the vEIR (-1: none), when, and
-- the words of units 0…heard_seq as played (verified against their signatures; null when the client did not
-- send them). The conversation history replays only these words of an interrupted reply.
ALTER TABLE turns ADD COLUMN IF NOT EXISTS heard_seq integer;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS interrupted_at timestamptz;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS heard_text text;
-- Added NOT VALID and validated separately, so the deploy never holds turns' exclusive lock for a full scan.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.turns'::regclass AND conname = 'turns_heard_seq_check') THEN
    ALTER TABLE turns ADD CONSTRAINT turns_heard_seq_check
      CHECK ((heard_seq IS NULL AND interrupted_at IS NULL AND heard_text IS NULL)
             OR (heard_seq BETWEEN -1 AND 10000 AND interrupted_at IS NOT NULL
                 AND (heard_text IS NULL OR (heard_seq >= 0 AND length(heard_text) BETWEEN 1 AND 40000))))
      NOT VALID;
  END IF;
END
$$;
ALTER TABLE turns VALIDATE CONSTRAINT turns_heard_seq_check;
CREATE INDEX IF NOT EXISTS turns_call_idx ON turns (call_id, ordinal) WHERE call_id IS NOT NULL;

-- What the founder heard is conversation content: whenever a turn's words are redacted (an ended temporary
-- chat, a deleted conversation), the heard words go with them.
CREATE OR REPLACE FUNCTION app.turns_redact_heard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.heard_text IS NOT NULL
     AND (NEW.founder_text IS DISTINCT FROM OLD.founder_text
          OR (NEW.response IS NULL AND OLD.response IS NOT NULL)) THEN
    NEW.heard_text := NULL;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.turns_redact_heard() FROM PUBLIC;
DROP TRIGGER IF EXISTS turns_redact_heard ON turns;
CREATE TRIGGER turns_redact_heard BEFORE UPDATE OF founder_text, response ON turns
  FOR EACH ROW EXECUTE FUNCTION app.turns_redact_heard();

-- A turn joins the live call of its author in its conversation: named explicitly (it must then be that call),
-- or implicitly while the call is alive (a heartbeat within the last minute).
CREATE OR REPLACE FUNCTION app.turns_link_call() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.call_id IS NULL THEN
    SELECT c.id INTO NEW.call_id FROM calls c
     WHERE c.session_id = NEW.session_id AND c.started_by = NEW.author_id AND c.status = 'live'
       AND coalesce(c.last_heartbeat_at, c.started_at) > now() - interval '60 seconds';
  ELSIF NOT EXISTS (SELECT 1 FROM calls c
                    WHERE c.id = NEW.call_id AND c.session_id = NEW.session_id AND c.started_by = NEW.author_id
                      AND c.status = 'live') THEN
    RAISE EXCEPTION 'a turn can only join a live call of its conversation started by its author'
      USING ERRCODE = '23514', CONSTRAINT = 'turns_call_live';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.turns_link_call() FROM PUBLIC;
DROP TRIGGER IF EXISTS turns_link_call ON turns;
CREATE TRIGGER turns_link_call BEFORE INSERT ON turns FOR EACH ROW EXECUTE FUNCTION app.turns_link_call();

-- ---------------------------------------------------------------------------------------------------
-- 3. Settings
-- ---------------------------------------------------------------------------------------------------

INSERT INTO platform_settings (key, value) VALUES ('calls_enabled', 'true') ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------
-- 4. Spend caps
-- ---------------------------------------------------------------------------------------------------

-- 0003's function with one change: the per-person sum leaves out purpose 'speech' (text-to-speech and
-- speech-to-text of calls), so a call never ends early on the per-person AI budget; calls are bounded by their
-- minute caps (per call and per person per day), their speech budgets (5.) and by the platform cap, which
-- counts every purpose.
-- usageRepo.spendToday counts the same way.
CREATE OR REPLACE FUNCTION app.spend_cap_state(p_global_cap numeric, p_principal_cap numeric) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH today AS (
    SELECT coalesce(sum(u.cost_usd), 0) AS global_usd,
           coalesce(sum(u.cost_usd) FILTER (WHERE u.principal_id = app.current_principal()
                                              AND u.purpose <> 'speech'), 0) AS principal_usd
    FROM usage_ledger u
    WHERE u.at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))
  SELECT CASE WHEN today.global_usd >= p_global_cap THEN 'global'
              WHEN today.principal_usd >= p_principal_cap THEN 'principal' END
  FROM today
$$;
REVOKE ALL ON FUNCTION app.spend_cap_state(numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.spend_cap_state(numeric, numeric) TO app_rls;

-- ---------------------------------------------------------------------------------------------------
-- 5. Speech of a call
-- ---------------------------------------------------------------------------------------------------

-- What a call had synthesized and how often (identifiers and counts only, never words): the intro, each
-- signed unit of a reply, each run of whole sentences of a stored reply, and a crisis turn's support message.
-- POST /speech reserves a play here in the same statement that adds the characters to the call's budget
-- (calls.speech_characters), before Amazon Polly is called; a synthesis that fails gives both back.
-- Owner role only, like the usage ledger: app_rls has no privileges on it.
CREATE TABLE IF NOT EXISTS call_speech (
  call_id     uuid NOT NULL REFERENCES calls (id),
  -- intro, unit.<turn id>.<seq>, run.<turn id>.<first sentence>.<last sentence> or crisis.<turn id>
  unit        text NOT NULL,
  plays       integer NOT NULL DEFAULT 1,
  characters  integer NOT NULL DEFAULT 0,
  first_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (call_id, unit),
  CONSTRAINT call_speech_unit_check CHECK (
    unit = 'intro'
    OR unit ~ '^(unit|run|crisis)[.][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}([.][0-9]{1,5}){0,2}$'),
  CONSTRAINT call_speech_counters_check CHECK (plays BETWEEN 0 AND 100 AND characters >= 0)
);
ALTER TABLE call_speech ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON call_speech FROM app_rls;
