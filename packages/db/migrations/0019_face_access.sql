-- Foundry Ascent — per-person video-face access: a platform admin lets one person see the face that a sandbox or
-- admins-only face vendor shows to platform admins only (docs/runbooks/avatars.md).
-- Applied on top of 0001–0018 (there is no 0014); expand-only: nothing an older build reads or writes changes, and
-- every statement is re-runnable (IF NOT EXISTS, CREATE OR REPLACE, REVOKE and GRANT).
--
--  1. principals.face_access: false for everyone until a platform admin turns it on (Admin › People & access,
--     `PATCH /admin/principals/<id>`, audited). It widens only WHO a sandbox or admins-only face is offered to;
--     faces on, the video minutes, the spend cap and likeness consent still decide whether a call has one.
--     app_rls holds column privileges on principals (0010), and this column is not granted: the API reads and
--     sets other people's values as the owner role, after its own platform-admin check, and nobody else reads
--     anyone's value through the table.
--  2. app.face_access() reads the caller's own value (false without an active request principal), so a call
--     re-reads it from the database each time it decides on a face, like the caller's roles.

-- ---------------------------------------------------------------------------------------------------
-- 1. The column, closed to app_rls (0010 granted app_rls only the columns it had then)
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE principals ADD COLUMN IF NOT EXISTS face_access boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------------------------------
-- 2. The caller's own value
-- ---------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.face_access() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT pr.face_access FROM principals pr
                    WHERE pr.id = app.current_principal() AND pr.tenant_id = app.current_tenant()
                      AND pr.status = 'active'), false)
$$;
REVOKE ALL ON FUNCTION app.face_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.face_access() TO app_rls;
