-- Separate student development from venture memory and session summaries. No model can write either table.
-- Additive schema; a code rollback can ignore it. Student context is scoped to a single venture.
CREATE TABLE IF NOT EXISTS student_profiles (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  venture_id uuid NOT NULL REFERENCES ventures(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, venture_id, principal_id)
);
CREATE TABLE IF NOT EXISTS learning_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  venture_id uuid NOT NULL REFERENCES ventures(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  reflection jsonb NOT NULL CHECK (jsonb_typeof(reflection) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS learning_log_recent ON learning_log(tenant_id, venture_id, principal_id, created_at DESC);
ALTER TABLE student_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS student_profiles_self ON student_profiles;
CREATE POLICY student_profiles_self ON student_profiles FOR ALL TO app_rls
  USING (tenant_id = app.current_tenant() AND principal_id = app.current_principal()
    AND app.venture_role(venture_id) IN ('founder', 'team'))
  WITH CHECK (tenant_id = app.current_tenant() AND principal_id = app.current_principal()
    AND app.venture_role(venture_id) IN ('founder', 'team'));
DROP POLICY IF EXISTS learning_log_self ON learning_log;
CREATE POLICY learning_log_self ON learning_log FOR ALL TO app_rls
  USING (tenant_id = app.current_tenant() AND principal_id = app.current_principal()
    AND app.venture_role(venture_id) IN ('founder', 'team'))
  WITH CHECK (tenant_id = app.current_tenant() AND principal_id = app.current_principal()
    AND app.venture_role(venture_id) IN ('founder', 'team'));
GRANT SELECT, INSERT, UPDATE, DELETE ON student_profiles, learning_log TO app_rls;
