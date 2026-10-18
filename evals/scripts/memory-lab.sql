-- A dedicated synthetic "Memory Lab" venture for remembered (multi-session) evaluation conversations, on a LOCAL
-- database only (evals/scripts/record-matrix-ci.sh). Two synthetic members (a founder and a teammate, for the
-- matrix `teammate` scenarios) and the same active vEIR assignment as QuietQuad (Corin's vEIR). Idempotent.
BEGIN;
WITH src AS (SELECT * FROM ventures WHERE name = 'QuietQuad'),
v AS (
  INSERT INTO ventures (tenant_id, name, one_liner, stage, domain, classification, status)
  SELECT tenant_id, 'Memory Lab', 'Dedicated synthetic venture for remembered evaluation conversations',
         'validation', 'software', 'synthetic', 'active'
  FROM src
  WHERE NOT EXISTS (SELECT 1 FROM ventures WHERE name = 'Memory Lab')
  RETURNING id, tenant_id
),
a AS (
  INSERT INTO assignments (tenant_id, venture_id, persona_id, eir_profile_id, allowed_modes, data_class_ceiling,
                           status, created_by)
  SELECT v.tenant_id, v.id, x.persona_id, x.eir_profile_id, x.allowed_modes, x.data_class_ceiling, 'active', x.created_by
  FROM v, assignments x JOIN src ON x.venture_id = src.id
  WHERE x.status = 'active'
  RETURNING id
),
p AS (
  INSERT INTO principals (tenant_id, display_name, synthetic, status)
  SELECT v.tenant_id, n.name, true, 'active'
  FROM v, (VALUES ('Mina Halloway-Test'), ('Rafi Okonkwo-Test')) AS n(name)
  RETURNING id, display_name
)
INSERT INTO venture_memberships (venture_id, principal_id, role)
SELECT v.id, p.id, CASE WHEN p.display_name = 'Mina Halloway-Test' THEN 'founder' ELSE 'team' END
FROM v, p;
COMMIT;
